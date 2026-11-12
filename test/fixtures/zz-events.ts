// 测试用的事件名：总线与 events 能力的用例拿它们当任意业务事件
declare module '../../packages/core/src/index.js' {
  interface AalisEvents {
    /** 带一个名字的事件 */
    'zz:named': [name: string];
    /** 不带参数的事件 */
    'zz:plain': [];
  }
}

export {};
