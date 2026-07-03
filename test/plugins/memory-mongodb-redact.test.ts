import { describe, expect, it } from 'vitest';
import { redactMongoUri } from '../../packages/plugin-memory-mongodb/src/index.js';

// ════════════════════════════════════════════════════════════
// MongoDB 连接串日志脱敏：避免密码明文进入日志。
// ════════════════════════════════════════════════════════════

describe('redactMongoUri', () => {
  it('脱敏 user:pass@ 的密码段', () => {
    expect(redactMongoUri('mongodb://admin:secret123@db.example.com:27017/aalis')).toBe(
      'mongodb://admin:***@db.example.com:27017/aalis',
    );
  });

  it('支持 mongodb+srv', () => {
    expect(redactMongoUri('mongodb+srv://u:p%40ss@cluster.mongodb.net/db')).toBe(
      'mongodb+srv://u:***@cluster.mongodb.net/db',
    );
  });

  it('无凭证的串原样返回（localhost）', () => {
    expect(redactMongoUri('mongodb://localhost:27017')).toBe('mongodb://localhost:27017');
  });

  it('只有用户名、无密码的串原样返回', () => {
    expect(redactMongoUri('mongodb://user@host:27017')).toBe('mongodb://user@host:27017');
  });
});
