import { describe, expect, it } from 'vitest';
import { DefaultLogger, LogHub } from '../../packages/core/src/index.js';

// 一次分发只送达它开始时已订阅的：分发途中新订阅的不收这一条，分发途中退订的不再收到。
// 每次订阅一条，同一函数订阅两次各算各的、各自退订。

const CAP = 1000; // 违例时会无限送达；数到上限停手，免得阻塞测试进程

describe('日志分发', () => {
  it('订阅者处理一条时退订再重订：同一条日志只送达一次', () => {
    const hub = new LogHub();
    const logger = new DefaultLogger('t', 'info', hub);
    let got = 0;
    hub.onEntry(() => {});
    const subscribe = () => {
      const off = hub.onEntry(() => {
        off();
        if (++got < CAP) subscribe();
      });
    };
    subscribe();
    logger.info('one');
    expect(got).toBe(1);
  });

  it('处理一条时退订了后一个订阅者：后一个这一条不再收到', () => {
    const hub = new LogHub();
    const logger = new DefaultLogger('t', 'info', hub);
    const got: string[] = [];
    let offLater = () => {};
    hub.onEntry(() => {
      got.push('first');
      offLater();
    });
    offLater = hub.onEntry(() => void got.push('later'));
    logger.info('one');
    expect(got).toEqual(['first']);
  });

  it('同一函数订阅两次各收一份，各自退订', () => {
    const hub = new LogHub();
    const logger = new DefaultLogger('t', 'info', hub);
    const got: string[] = [];
    const listener = (entry: { message: string }) => void got.push(entry.message);
    const offFirst = hub.onEntry(listener);
    hub.onEntry(listener);
    logger.info('a');
    offFirst();
    logger.info('b');
    expect(got).toEqual(['a', 'a', 'b']);
  });
});
