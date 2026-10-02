// 首帧主题：在打包的脚本之前同步执行，按存着的外观选择写上 <html data-theme>，页面第一帧就是选定的主题。
// 外观选择存在 aalis.appearance（JSON）：{ follow: true, dark, light } 跟随系统，分别指定深色、浅色用哪个主题；
// { follow: false, theme } 固定一个主题。没存过、存坏了或存储不可用时跟随系统，用偏中性的深浅两个；选中的主题
// 没有规则（改了名、没写主题）时页面没有颜色，同样按系统深浅用偏中性的那个。内置主题的规则内联在本脚本之前。
// 这是页面里唯一不经存储模块读浏览器存储的地方：存储模块在打包的脚本里，首帧之前还没加载。
(() => {
  let choice = {};
  try {
    choice = JSON.parse(localStorage.getItem('aalis.appearance')) ?? {};
  } catch {
    // 读不到按默认
  }
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const root = document.documentElement;
    const neutral = dark.matches ? 'calm-dark' : 'calm-light';
    root.dataset.theme =
      choice.follow === false ? choice.theme : dark.matches ? (choice.dark ?? neutral) : (choice.light ?? neutral);
    if (!getComputedStyle(root).getPropertyValue('--color-bg')) root.dataset.theme = neutral;
  };
  apply();
  dark.addEventListener('change', apply);
})();
