import { describe, expect, it } from 'vitest';
import memoryMongo from '../../packages/plugin-memory-mongodb/src/index.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

// 只解析插件公开的 schema；不激活插件，也不构造 MongoClient。
describe('plugin-memory-mongodb 配置目标', () => {
  it.each([{ database: false }, { collection: [] }, { uri: {} }])('显式坏目标字段拒绝配置：%j', config => {
    expect(() => parseConfig(memoryMongo.configSchema!, config)).toThrow();
  });

  it('缺省 URI 沿用原默认值，空数据库名留给实例派生', () => {
    const cfg = parseConfig(memoryMongo.configSchema!, { database: '' });
    expect(cfg.uri).toBe('mongodb://localhost:27017');
    expect(cfg.database).toBe('');
  });
});
