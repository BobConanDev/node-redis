import TestUtils from '@redis/test-utils';
import { SinonSpy } from 'sinon';
import { setTimeout } from 'node:timers/promises';

const utils = new TestUtils({
  dockerImageName: 'redis/redis-stack',
  dockerImageVersionArgument: 'redis-version',
  defaultDockerVersion: '7.4.0-v1'
});

export default utils;

const DEBUG_MODE_ARGS = utils.isVersionGreaterThan([7]) ?
  ['--enable-debug-command', 'yes'] :
  [];

export const GLOBAL = {
  SERVERS: {
    OPEN: {
      serverArguments: [...DEBUG_MODE_ARGS]
    },
    PASSWORD: {
      serverArguments: ['--requirepass', 'password', ...DEBUG_MODE_ARGS],
      clientOptions: {
        password: 'password'
      }
    }
  },
  CLUSTERS: {
    OPEN: {
      serverArguments: [...DEBUG_MODE_ARGS]
    },
    PASSWORD: {
      serverArguments: ['--requirepass', 'password', ...DEBUG_MODE_ARGS],
      clusterConfiguration: {
        defaults: {
          password: 'password'
        }
      }
    },
    WITH_REPLICAS: {
      serverArguments: [...DEBUG_MODE_ARGS],
      numberOfMasters: 2,
      numberOfReplicas: 1,
      clusterConfiguration: {
        useReplicas: true
      }
    }
  }
};

export async function waitTillBeenCalled(spy: SinonSpy): Promise<void> {
  const start = process.hrtime.bigint(),
    calls = spy.callCount;

  do {
    if (process.hrtime.bigint() - start > 1_000_000_000) {
      throw new Error('Waiting for more than 1 second');
    }

    await setTimeout(50);
  } while (spy.callCount === calls);
}

export const BLOCKING_MIN_VALUE = (
  utils.isVersionGreaterThan([7]) ? Number.MIN_VALUE :
  utils.isVersionGreaterThan([6]) ? 0.01 :
  1
);
