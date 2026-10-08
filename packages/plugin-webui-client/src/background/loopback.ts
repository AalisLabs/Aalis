// 本机网址：后台任务输出的最后一行里的本机地址（开发服务器最常打出的那种）。只有页面本身经回环地址打开时，浏览器与
// 这台守护进程在同一台机器上，点开才到得了那个服务；从别的机器打开的页面点开会连到看页面的那台机器自己，只显示地址。
// 客户端只有这里写回环地址（写法守卫的例外）

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 一行里第一个 http、https 的本机网址：主机名与端口后面到分隔符为止还有字母或数字的（localhost.example.com、
 * localhost@evil.com）不算；到空白、引号、尖括号或控制符（终端的颜色码）为止
 */
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?![^/?#\s"'<>\p{Cc}]*\w)(?:[/?#][^\s"'<>\p{Cc}]*)?/u;

/** 网址后面紧跟的句末标点与右括号 */
const TRAILING_PUNCT = /[.,;:!?)\]}）。，、；：！？]+$/;

/** 这一行里能点开的本机网址：页面经回环地址打开、行里有本机网址时才有 */
export function openableLocalUrl(line: string): string | undefined {
  if (!LOOPBACK_HOSTS.includes(location.hostname)) return undefined;
  return LOCAL_URL.exec(line)?.[0].replace(TRAILING_PUNCT, '');
}
