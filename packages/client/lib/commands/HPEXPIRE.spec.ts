import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import { transformArguments } from './HPEXPIRE';
import { HASH_EXPIRATION_TIME } from './HEXPIRETIME';

describe('HEXPIRE', () => {
  testUtils.isVersionGreaterThanHook([7, 4]);

  describe('transformArguments', () => {
    it('string', () => {
      assert.deepEqual(
        transformArguments('key', 'field', 1),
        ['HPEXPIRE', 'key', '1', 'FIELDS', '1', 'field']
      );
    });

    it('array', () => {
      assert.deepEqual(
        transformArguments('key', ['field1', 'field2'], 1),
        ['HPEXPIRE', 'key', '1', 'FIELDS', '2', 'field1', 'field2']
      );
    });

    it('with set option', () => {
      assert.deepEqual(
        transformArguments('key', ['field1'], 1, 'NX'),
        ['HPEXPIRE', 'key', '1', 'NX', 'FIELDS', '1', 'field1']
      );
    });
  });

  testUtils.testWithClient('hexpire', async client => {
    assert.deepEqual(
      await client.hpExpire('key', ['field1'], 0),
      [HASH_EXPIRATION_TIME.FIELD_NOT_EXISTS]
    );
  }, {
    ...GLOBAL.SERVERS.OPEN
  });
});
