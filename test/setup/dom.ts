// jsdom 没有排版，Element 上没有 scrollIntoView：补一个空操作，组件照常调用；要核滚动的用例在原型上打 spy
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
