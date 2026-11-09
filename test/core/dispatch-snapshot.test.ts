import { describe, expect, it } from 'vitest';
import { DefaultLogger, LogHub } from '../../packages/core/src/index.js';
import { EventBus } from '../../packages/core/src/primitives/events.js';

// 一次派发只送达它开始时已登记的：派发途中新登记的不收这一次（sticky 事件另经补发收到一次），派发途中退订的不再收到。
// 事件总线与日志分发同一规则，登记也同一规则：每次登记一条，同一函数登记两次各算各的、各自退订。

declare module '../../packages/core/src/index.js' {
  interface AalisEvents {
    'zz-dispatch:tick': [n: number];
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const CAP = 1000; // 违例时会无限送达；数到上限停手，免得阻塞测试进程

describe('事件总线：派发只送达开始时已登记的', () => {
  it('监听器处理时退订自己再重新登记：一次 emit 只送达一次', async () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on('zz-dispatch:tick', () => {});
    const arm = () => {
      const off = bus.on('zz-dispatch:tick', () => {
        off();
        if (++calls < CAP) arm();
      });
    };
    arm();
    await bus.emit('zz-dispatch:tick', 1);
    expect(calls).toBe(1);
    await bus.emit('zz-dispatch:tick', 2);
    expect(calls).toBe(2);
  });

  it('派发途中被前一个监听器退订的：这一次不再收到', async () => {
    const bus = new EventBus();
    const got: string[] = [];
    let offLater = () => {};
    bus.on('zz-dispatch:tick', () => {
      got.push('first');
      offLater();
    });
    offLater = bus.on('zz-dispatch:tick', () => void got.push('later'));
    await bus.emit('zz-dispatch:tick', 1);
    expect(got).toEqual(['first']);
  });

  it('sticky 事件嵌套 emit 之后，外层派发途中登记的监听器只收到一次', async () => {
    const bus = new EventBus({ sticky: ['app:ready'] });
    let nested = false;
    let secondCalls = 0;
    let late = 0;
    bus.on('app:ready', async () => {
      if (nested) return;
      nested = true;
      await bus.emit('app:ready');
    });
    bus.on('app:ready', () => {
      if (++secondCalls === 2) bus.on('app:ready', () => void late++);
    });
    await bus.emit('app:ready');
    await tick();
    expect(late).toBe(1);
  });
  it('sticky 事件外层派发途中登记、随后嵌套再发一次：登记的监听器经嵌套那次收到，不再补发', async () => {
    const bus = new EventBus({ sticky: ['app:ready'] });
    let registered = false;
    let calls = 0;
    bus.on('app:ready', async () => {
      if (registered) return;
      registered = true;
      bus.on('app:ready', () => void calls++);
      await bus.emit('app:ready');
    });
    await bus.emit('app:ready');
    await tick();
    expect(calls).toBe(1);
  });
});

describe('日志分发：与事件总线同一规则', () => {
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
