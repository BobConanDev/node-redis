import { NullReply, ArrayReply, BlobStringReply, DoubleReply, UnwrapReply, Command, TypeMapping } from '@redis/client/dist/lib/RESP/types';
import { isNullReply, transformDoubleReply } from '@redis/client/dist/lib/commands/generic-transformers';
import SUGGET from './SUGGET';

type SuggestScoreWithPayload = {
  suggestion: BlobStringReply;
  score: DoubleReply;
  payload: BlobStringReply;
}

export default {
  FIRST_KEY_INDEX: SUGGET.FIRST_KEY_INDEX,
  IS_READ_ONLY: SUGGET.IS_READ_ONLY,
  transformArguments(...args: Parameters<typeof SUGGET.transformArguments>) {
    const transformedArguments = SUGGET.transformArguments(...args);
    transformedArguments.push(
      'WITHSCORES',
      'WITHPAYLOADS'
    );
    return transformedArguments;
  },
  transformReply: {
    2: (reply: NullReply | UnwrapReply<ArrayReply<BlobStringReply>>, preserve?: any, typeMapping?: TypeMapping) => {
      if (isNullReply(reply)) return null;

      const transformedReply: Array<SuggestScoreWithPayload> = new Array(reply.length / 3);
      let replyIndex = 0,
        arrIndex = 0;
      while (replyIndex < reply.length) {
        transformedReply[arrIndex++] = {
          suggestion: reply[replyIndex++],
          score: transformDoubleReply[2](reply[replyIndex++], preserve, typeMapping),
          payload: reply[replyIndex++]
        };
      }

      return transformedReply;
    },
    3: (reply: NullReply | UnwrapReply<ArrayReply<BlobStringReply | DoubleReply>>) => {
      if (isNullReply(reply)) return null;

      const transformedReply: Array<SuggestScoreWithPayload> = new Array(reply.length / 3);
      let replyIndex = 0,
        arrIndex = 0;
      while (replyIndex < reply.length) {
        transformedReply[arrIndex++] = {
          suggestion: reply[replyIndex++] as BlobStringReply,
          score: reply[replyIndex++] as DoubleReply,
          payload: reply[replyIndex++] as BlobStringReply
        };
      }

      return transformedReply;
    }
  }
} as const satisfies Command;
