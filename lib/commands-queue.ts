import LinkedList, { Node } from 'yallist';
import RedisParser from 'redis-parser';
import { AbortError } from './errors';
import { RedisReply } from './commands';

export interface QueueCommandOptions {
    asap?: boolean;
    signal?: AbortSignal;
    chainId?: Symbol;
}

interface CommandWaitingToBeSent extends CommandWaitingForReply {
    encodedCommand: string;
    chainId?: Symbol;
    abort?: {
        signal: AbortSignal;
        listener(): void;
    };
}

interface CommandWaitingForReply {
    resolve(reply?: any): void;
    reject(err: Error): void;
    channelsCounter?: number;
}

export type CommandsQueueExecutor = (encodedCommands: string) => boolean | undefined;

export enum PubSubSubscribeCommands {
    SUBSCRIBE = 'SUBSCRIBE',
    PSUBSCRIBE = 'PSUBSCRIBE'
}

export enum PubSubUnsubscribeCommands {
    UNSUBSCRIBE = 'UNSUBSCRIBE',
    PUNSUBSCRIBE = 'PUNSUBSCRIBE'
}

export type PubSubListener = (message: string, channel: string) => unknown;

export type PubSubListenersMap = Map<string, Set<PubSubListener>>;

export default class RedisCommandsQueue {
    static encodeCommand(args: Array<string>): string {
        const encoded = [
            `*${args.length}`,
            `$${args[0].length}`,
            args[0]
        ];

        for (let i = 1; i < args.length; i++) {
            const str = args[i].toString();
            encoded.push(`$${str.length}`, str);
        }

        return encoded.join('\r\n') + '\r\n';
    }

    static #flushQueue<T extends CommandWaitingForReply>(queue: LinkedList<T>, err: Error): void {
        while (queue.length) {
            queue.shift()!.reject(err);
        }
    }

    static #emitPubSubMessage(listeners: Set<PubSubListener>, message: string, channel: string): void {
        for (const listener of listeners) {
            listener(message, channel);
        }
    }

    readonly #maxLength: number | null | undefined;

    readonly #executor: CommandsQueueExecutor;

    readonly #waitingToBeSent = new LinkedList<CommandWaitingToBeSent>();

    readonly #waitingForReply = new LinkedList<CommandWaitingForReply>();

    readonly #pubSubState = {
        subscribing: 0,
        subscribed: 0,
        unsubscribing: 0
    };

    readonly #pubSubListeners = {
        channels: <PubSubListenersMap>new Map(),
        patterns: <PubSubListenersMap>new Map()
    };

    readonly #parser = new RedisParser({
        returnReply: (reply: unknown) => {
            if ((this.#pubSubState.subscribing || this.#pubSubState.subscribed) && Array.isArray(reply)) {
                switch (reply[0]) {
                    case 'message':
                        return RedisCommandsQueue.#emitPubSubMessage(
                            this.#pubSubListeners.channels.get(reply[1])!,
                            reply[2],
                            reply[1]
                        );
                    
                    case 'pmessage':
                        return RedisCommandsQueue.#emitPubSubMessage(
                            this.#pubSubListeners.patterns.get(reply[1])!,
                            reply[3],
                            reply[2]
                        );

                    case 'subscribe':
                    case 'psubscribe':
                        if (--this.#waitingForReply.head!.value.channelsCounter! === 0) {
                            this.#shiftWaitingForReply().resolve(); 
                        }
                        return;
                }
            }
            
            this.#shiftWaitingForReply().resolve(reply);
        },
        returnError: (err: Error) => this.#shiftWaitingForReply().reject(err)
    });

    #chainInExecution: Symbol | undefined;

    constructor(maxLength: number | null | undefined, executor: CommandsQueueExecutor) {
        this.#maxLength = maxLength;
        this.#executor = executor;
    }

    #isQueueBlocked<T = void>(): Promise<T> | undefined {
        if (this.#pubSubState.subscribing || this.#pubSubState.subscribed) {
            return Promise.reject(new Error('Cannot send commands in PubSub mode'));
        } else if (!this.#maxLength) {
            return;
        }

        return this.#waitingToBeSent.length + this.#waitingForReply.length >= this.#maxLength ?
            Promise.reject(new Error('The queue is full')) :
            undefined;
    }

    addCommand<T = RedisReply>(args: Array<string>, options?: QueueCommandOptions): Promise<T> {
        return this.#isQueueBlocked<T>() || this.addEncodedCommand(
            RedisCommandsQueue.encodeCommand(args),
            options
        );
    }

    addEncodedCommand<T = RedisReply>(encodedCommand: string, options?: QueueCommandOptions): Promise<T> {
        const fullQueuePromise = this.#isQueueBlocked<T>();
        if (fullQueuePromise) {
            return fullQueuePromise;
        } else if (options?.signal?.aborted) {
            return Promise.reject(new AbortError());
        }

        return new Promise((resolve, reject) => {
            const node = new LinkedList.Node<CommandWaitingToBeSent>({
                encodedCommand,
                chainId: options?.chainId,
                resolve,
                reject
            });

            if (options?.signal) {
                const listener = () => {
                    this.#waitingToBeSent.removeNode(node);
                    node.value.reject(new AbortError());
                };

                if (options.signal.aborted) {
                    return listener();
                }

                node.value.abort = {
                    signal: options.signal,
                    listener
                };
                options.signal.addEventListener('abort', listener, {
                    once: true
                });
            }

            if (options?.asap) {
                this.#waitingToBeSent.unshiftNode(node);
            } else {
                this.#waitingToBeSent.pushNode(node);
            }
        });
    }

    subscribe(command: PubSubSubscribeCommands, channels: string | Array<string>, listener: PubSubListener): Promise<void> {
        const channelsToSubscribe: Array<string> = [],
            listeners = command === PubSubSubscribeCommands.SUBSCRIBE ? this.#pubSubListeners.channels : this.#pubSubListeners.patterns;
        for (const channel of (Array.isArray(channels) ? channels : [channels])) {
            if (listeners.has(channel)) {
                listeners.get(channel)!.add(listener);
                continue;
            }

            listeners.set(channel, new Set([listener]));
            channelsToSubscribe.push(channel);
        }

        return this.#pushPubSubCommand(command, channelsToSubscribe);
    }

    unsubscribe(command: PubSubUnsubscribeCommands, channels: string | Array<string>, listener?: PubSubListener) {
        const listeners = command === PubSubUnsubscribeCommands.UNSUBSCRIBE ? this.#pubSubListeners.channels : this.#pubSubListeners.patterns,
            channelsToUnsubscribe = [];
        for (const channel of (Array.isArray(channels) ? channels : [channels])) {
            const set = listeners.get(channel);
            if (!set) continue;

            let shouldUnsubscribe = !listener;
            if (listener) {
                set.delete(listener);
                shouldUnsubscribe = set.size === 0;
            }

            if (shouldUnsubscribe) {
                channelsToUnsubscribe.push(channel);
                listeners.delete(channel);
            }
        }

        return this.#pushPubSubCommand(command, channelsToUnsubscribe);
    }

    #pushPubSubCommand(command: PubSubSubscribeCommands | PubSubUnsubscribeCommands, channels: Array<string>): Promise<void> {
        if (!channels.length) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const isSubscribe = command === PubSubSubscribeCommands.SUBSCRIBE || command === PubSubSubscribeCommands.PSUBSCRIBE,
                inProgressKey = isSubscribe ? 'subscribing' : 'unsubscribing';
            
            this.#pubSubState[inProgressKey] += channels.length;
            this.#waitingToBeSent.push({
                encodedCommand: RedisCommandsQueue.encodeCommand([command, ...channels]),
                channelsCounter: channels.length,
                resolve: () => {
                    this.#pubSubState[inProgressKey] -= channels.length;
                    this.#pubSubState.subscribed += channels.length * (isSubscribe ? 1 : -1);
                    resolve();
                },
                reject: () => {
                    this.#pubSubState[inProgressKey] -= channels.length;
                    reject();
                }
            });
        });
    }

    resubscribe(): Promise<any> | undefined {
        if (!this.#pubSubState.subscribed && !this.#pubSubState.subscribing) {
            return;
        }

        this.#pubSubState.subscribed = this.#pubSubState.subscribing = 0;

        // TODO: acl error on one channel/pattern will reject the whole command
        return Promise.all([
            this.#pushPubSubCommand(PubSubSubscribeCommands.SUBSCRIBE, [...this.#pubSubListeners.channels.keys()]),
            this.#pushPubSubCommand(PubSubSubscribeCommands.PSUBSCRIBE, [...this.#pubSubListeners.patterns.keys()])
        ]);
    }

    executeChunk(recommendedSize: number): boolean | undefined {
        if (!this.#waitingToBeSent.length) return;

        const encoded: Array<string> = [];
        let size = 0,
            lastCommandChainId: Symbol | undefined;
        for (const command of this.#waitingToBeSent) {
            encoded.push(command.encodedCommand);
            size += command.encodedCommand.length;
            if (size > recommendedSize) {
                lastCommandChainId = command.chainId;
                break;
            }
        }

        if (!lastCommandChainId && encoded.length === this.#waitingToBeSent.length) {
            lastCommandChainId = this.#waitingToBeSent.tail!.value.chainId;
        }

        lastCommandChainId ??= this.#waitingToBeSent.tail?.value.chainId;

        this.#executor(encoded.join(''));

        for (let i = 0; i < encoded.length; i++) {
            const waitingToBeSent = this.#waitingToBeSent.shift()!;
            if (waitingToBeSent.abort) {
                waitingToBeSent.abort.signal.removeEventListener('abort', waitingToBeSent.abort.listener);
            }

            this.#waitingForReply.push({
                resolve: waitingToBeSent.resolve,
                reject: waitingToBeSent.reject,
                channelsCounter: waitingToBeSent.channelsCounter
            });
        }

        this.#chainInExecution = lastCommandChainId;
    }

    parseResponse(data: Buffer): void {
        this.#parser.execute(data);
    }

    #shiftWaitingForReply(): CommandWaitingForReply {
        if (!this.#waitingForReply.length) {
            throw new Error('Got an unexpected reply from Redis');
        }

        return this.#waitingForReply.shift()!;
    }

    flushWaitingForReply(err: Error): void {
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);

        if (!this.#chainInExecution) {
            return;
        }

        while (this.#waitingToBeSent.head?.value.chainId === this.#chainInExecution) {
            this.#waitingToBeSent.shift();
        }

        this.#chainInExecution = undefined;
    }

    flushAll(err: Error): void {
        RedisCommandsQueue.#flushQueue(this.#waitingForReply, err);
        RedisCommandsQueue.#flushQueue(this.#waitingToBeSent, err);
    }
};