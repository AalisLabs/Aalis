// 测试用的事件名：总线与 events 门面的用例拿它们当任意业务事件
declare module '@aalis/api-events' {
  interface AalisEvents {
    /** 带一个名字的事件 */
    'zz:named': [name: string];
    /** 不带参数的事件 */
    'zz:plain': [];
  }
}

export {};
