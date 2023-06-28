import { strict as assert } from 'assert';
import testUtils, { GLOBAL } from '../test-utils';
import { transformArguments } from './XGROUP_CREATE';

describe('XGROUP CREATE', () => {
  describe('transformArguments', () => {
    it('simple', () => {
      assert.deepEqual(
        transformArguments('key', 'group', '$'),
        ['XGROUP', 'CREATE', 'key', 'group', '$']
      );
    });

    it('with MKSTREAM', () => {
      assert.deepEqual(
        transformArguments('key', 'group', '$', {
          MKSTREAM: true
        }),
        ['XGROUP', 'CREATE', 'key', 'group', '$', 'MKSTREAM']
      );
    });

    it('with ENTRIESREAD', () => {
      assert.deepEqual(
        transformArguments('key', 'group', '$', {
          ENTRIESREAD: 1
        }),
        ['XGROUP', 'CREATE', 'key', 'group', '$', 'ENTRIESREAD', '1']
      );
    });
  });

  testUtils.testAll('xGroupCreate', async client => {
    assert.equal(
      await client.xGroupCreate('key', 'group', '$', {
        MKSTREAM: true
      }),
      'OK'
    );
  }, {
    client: GLOBAL.SERVERS.OPEN,
    cluster: GLOBAL.SERVERS.OPEN
  });
});
