import { describe, expect, it } from 'vitest';
import { protectedLists, withRealRoots } from '../../packages/api-reach/src/index.js';
import { derivePaths } from '../../packages/runtime/src/home.js';
import { CODE_DIR, inList, LISTS, PATHS, USER } from '../fixtures/reach.js';

// ════════════════════════════════════════════════════════════
// 三张清单：宿主控制面（一律拒写）、持久化与自动执行落点、拒读清单。由家目录布局、用户家目录与平台生成，
// 工具边界与沙箱用同一份。路径是真实路径；macOS 与 Windows 上比较不分大小写，Windows 的分隔符两种都认。
// ════════════════════════════════════════════════════════════

/** 每个路径在清单里命中与否，与期望逐条比对 */
function expectHits(list: 'control' | 'landing' | 'denyRead', cases: Array<[string, boolean]>, lists = LISTS) {
  expect(cases.map(([path]) => [path, inList(lists[list], path, lists)])).toEqual(cases);
}

describe('宿主控制面', () => {
  it('家目录下除白纸、临时区与技能目录以外的全部；安装集的依赖与构建产物；安装集外加载的插件目录', () => {
    expectHits('control', [
      [`${PATHS.state}/db`, true],
      [PATHS.config, true],
      [PATHS.secrets, true],
      [`${PATHS.logs}/latest.log`, true],
      [`${PATHS.run}/aalis.sock`, true],
      [`${PATHS.self.workflows}/daily.yaml`, true],
      [`${PATHS.self.personas}/default.md`, true],
      [`${PATHS.stage.public}/index.html`, true],
      [`${PATHS.stage.paper}/p-default/a.md`, false],
      [`${PATHS.tmp}/sessions/7331/x`, false],
      [`${PATHS.self.skills}/s/SKILL.md`, false],
      ['/opt/aalis/node_modules/@aalis/core/dist/index.js', true],
      ['/opt/aalis/dist/index.js', true],
      ['/opt/aalis/packages/core/dist/index.js', true],
      ['/opt/aalis/packages/core/node_modules/x/index.js', true],
      ['/opt/aalis/packages/core/src/index.ts', false],
      [`${CODE_DIR}/dist/index.js`, true],
      ['/u/code/proj/src/a.ts', false],
      ['/opt/aalis/package.json', false], // 源码形态：在改的源码
    ]);
  });

  it('npm 形态（create-aalis 生成的项目，家目录在安装集里）：另有守护进程的入口与安装集的 package.json', () => {
    const npm = (entry?: string) =>
      protectedLists({
        paths: derivePaths('/u/proj/home', '/u/proj'),
        userHome: USER,
        platform: 'linux',
        form: 'npm',
        codeDirs: [],
        ...(entry ? { entry } : {}),
      });
    expectHits(
      'control',
      [
        ['/u/proj/index.mjs', true],
        ['/u/proj/package.json', true],
        ['/u/proj/README.md', false],
      ],
      npm('/u/proj/index.mjs'),
    );
    expectHits(
      'control',
      [
        ['/u/proj/index.mjs', false],
        ['/u/proj/package.json', true],
      ],
      npm(),
    );
  });
});

describe('按真实路径补上链接出去的根', () => {
  it('根的真实路径与写法不同时另加一份，根下的例外随根挪过去；按正则写的规则、取不到或相同的不加', () => {
    const real: Record<string, string> = {
      [PATHS.home]: '/data/aalis',
      [PATHS.secrets]: '/u/dotfiles/secrets.yaml',
      '/u/.zshrc': '/u/dotfiles/zshrc',
      '/u/.ssh': '/u/.ssh',
    };
    const lists = withRealRoots(LISTS, path => real[path]);
    expectHits(
      'control',
      [
        ['/data/aalis/state/db', true],
        ['/data/aalis/stage/paper/p-default/a.md', false],
        ['/data/aalis/tmp/sessions/7331/x', false],
        [`${PATHS.stage.paper}/p-default/a.md`, false],
        ['/u/dotfiles/secrets.yaml', true],
      ],
      lists,
    );
    expectHits(
      'denyRead',
      [
        ['/data/aalis/state/db', true],
        ['/data/aalis/logs/latest.log', false],
        ['/u/dotfiles/secrets.yaml', true],
      ],
      lists,
    );
    expectHits('landing', [['/u/dotfiles/zshrc', true]], lists);
    expect(lists.landing.length - LISTS.landing.length, '只加 ~/.zshrc 一条').toBe(1);
    expect(lists.denyRead.length - LISTS.denyRead.length, '家目录与 secrets.yaml 各一条').toBe(2);
  });

  it('macOS 上真实路径只差大小写的不加', () => {
    const mac = protectedLists({
      paths: derivePaths('/Users/u/.aalis', '/opt/aalis'),
      userHome: '/Users/u',
      platform: 'darwin',
      form: 'source',
      codeDirs: [],
    });
    expect(withRealRoots(mac, path => path.toLowerCase())).toEqual(mac);
  });
});

describe('持久化与自动执行落点', () => {
  it('git 的钩子、配置与能把目录变成 git 仓库的文件', () => {
    expectHits('landing', [
      ['/u/code/proj/.git/hooks/pre-commit', true],
      ['/u/code/proj/.git/config', true],
      ['/u/code/proj/.git/config.worktree', true],
      ['/u/code/proj/.git/modules/sub/config', true],
      ['/u/code/proj/.git/modules/a/modules/b/config', true],
      ['/u/code/proj/.git/modules/sub/hooks/post-checkout', true],
      ['/u/code/proj/.git/worktrees/wt/config.worktree', true],
      // commondir 指向的目录被 git 当作共用目录，配置与钩子都从那里取
      ['/u/code/proj/.git/commondir', true],
      ['/u/code/proj/.git/worktrees/prod/commondir', true],
      ['/u/code/proj/.git/modules/sub/commondir', true],
      ['/u/code/proj/sub/.git', true], // 子模块工作树里文件形式的 .git
      ['/u/code/proj/.git/HEAD', false],
      ['/u/code/proj/.git/worktrees/wt/HEAD', false],
      ['/u/code/proj/.git/worktrees/wt/index', false],
      ['/u/code/proj/.git/config.lock', false], // git 先写锁文件再改名，改名落到 .git/config 才拦
      ['/u/code/proj/.git/objects/ab/cd', false],
      ['/u/code/proj/.git/index', false],
      ['/u/code/proj/src/head.ts', false],
    ]);
  });

  it('装着落点的目录本身也是落点：在别处摆好整棵子树再改名到位，改名的一端总会命中', () => {
    expectHits('landing', [
      ['/u/code/proj/.vscode', true],
      ['/u/code/proj/.claude', true],
      ['/u/code/proj/.cursor', true],
      ['/u/code/proj/.codex', true],
      ['/u/code/proj/.vscode-old', false],
      ['/u/code/proj/.git/worktrees', true],
      ['/u/code/proj/.git/worktrees/wt', true],
      // 子模块的名字可以带斜杠、可以嵌套，按目录名列不全：.git/modules 整棵都是落点
      ['/u/code/proj/.git/modules', true],
      ['/u/code/proj/.git/modules/sub', true],
      ['/u/code/proj/.git/modules/sub/objects/ab/cd', true],
      ['/u/.config', true],
      ['/u/.config/systemd', true],
    ]);
    const mac = protectedLists({
      paths: derivePaths('/Users/u/.aalis', '/opt/aalis'),
      userHome: '/Users/u',
      platform: 'darwin',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'landing',
      [
        ['/Users/u/Library', true],
        ['/Users/u/Library/Caches/x', false],
      ],
      mac,
    );
  });

  it('shell 与登录', () => {
    expectHits('landing', [
      ['/u/.zshrc', true],
      ['/u/.bashrc', true],
      ['/u/.profile', true],
      ['/u/.config/fish/config.fish', true],
      ['/u/.ssh/authorized_keys', true],
      ['/u/.ssh/config', true],
      ['/u/.gitconfig', true],
      ['/u/.config/git/config', true],
      ['/u/.config/systemd/user/x.service', true],
      ['/u/.config/autostart/x.desktop', true],
      ['/u/.config/other/x', false],
    ]);
    const mac = protectedLists({
      paths: derivePaths('/Users/u/.aalis', '/opt/aalis'),
      userHome: '/Users/u',
      platform: 'darwin',
      form: 'source',
      codeDirs: [],
    });
    expectHits('landing', [['/Users/u/Library/LaunchAgents/x.plist', true]], mac);
  });

  it('项目里会被工具自动执行的配置与项目指令', () => {
    expectHits('landing', [
      ['/u/code/proj/.envrc', true],
      ['/u/code/proj/.vscode/tasks.json', true],
      ['/u/code/proj/.vscode/settings.json', true],
      ['/u/code/proj/.vscode/launch.json', false],
      ['/u/code/proj/proj.code-workspace', true],
      ['/u/code/proj/.husky/pre-commit', true],
      ['/u/code/proj/.pre-commit-config.yaml', true],
      ['/u/code/proj/.claude/settings.json', true],
      ['/u/code/proj/.claude/settings.local.json', true],
      ['/u/code/proj/.mcp.json', true],
      ['/u/code/proj/.cursor/hooks.json', true],
      ['/u/code/proj/.cursor/mcp.json', true],
      ['/u/code/proj/.cursor/rules/a.mdc', false],
      ['/u/code/proj/.codex/config.toml', true],
      ['/u/code/proj/.codex/rules/a.rules', true],
      ['/u/code/proj/.codex/hooks.json', true],
      ['/u/code/proj/AALIS.md', true],
      ['/u/code/proj/docs/AGENTS.md', true],
      ['/u/code/proj/README.md', false],
      ['/u/code/proj/.aalis/settings.json', true],
      [`${PATHS.stage.paper}/p-default/a.md`, false], // 实例家目录本身叫 .aalis，不算项目的 .aalis/
      [`${PATHS.stage.paper}/p-default/repo/.aalis/settings.json`, true], // 白纸里项目自己的 .aalis/ 照样算
    ]);
  });
});

describe('拒读清单', () => {
  it('家目录里只放行舞台、self、本实例的日志与主配置；其他实例的家目录整个拒读', () => {
    expectHits('denyRead', [
      [PATHS.secrets, true],
      [`${PATHS.state}/db`, true],
      [`${PATHS.run}/aalis.sock`, true],
      [`${PATHS.cache}/x`, true],
      [`${PATHS.tmp}/sessions/7331/x`, true], // 本会话临时区由触及按会话放行，清单里不放
      [`${PATHS.stage.paper}/p-default/a.md`, false],
      [`${PATHS.stage.public}/index.html`, false],
      [`${PATHS.self.skills}/s/SKILL.md`, false],
      // 舞台与 self 整个放行：两个目录本身与以后新加的条目都读得到
      [`${PATHS.home}/stage`, false],
      [`${PATHS.home}/self`, false],
      [`${PATHS.home}/stage/zz-new/x`, false],
      [`${PATHS.home}/self/zz-new`, false],
      [`${PATHS.logs}/latest.log`, false],
      [PATHS.config, false],
      ['/u/.aalis-dev/aalis.config.yaml', true],
      ['/u/.aalis-x/state/db', true],
      ['/u/.aalisx/a', false],
    ]);
    const dev = protectedLists({
      paths: derivePaths('/u/.aalis-dev', '/opt/aalis'),
      userHome: '/u',
      platform: 'linux',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'denyRead',
      [
        ['/u/.aalis/aalis.config.yaml', true],
        ['/u/.aalis-dev/logs/latest.log', false],
      ],
      dev,
    );
  });

  it('凭据文件、浏览器配置目录与 .env*（豁免三种样例文件）', () => {
    expectHits('denyRead', [
      ['/u/.ssh/id_ed25519', true],
      ['/u/.aws/credentials', true],
      ['/u/.config/gh/hosts.yml', true],
      ['/u/.npmrc', true],
      ['/u/.netrc', true],
      ['/u/.git-credentials', true],
      ['/u/.gnupg/pubring.kbx', true],
      ['/u/.docker/config.json', true],
      ['/u/.docker/contexts/x', false],
      ['/u/.kube/config', true],
      ['/u/.config/google-chrome/Default/Cookies', true],
      ['/u/.mozilla/firefox/x/cookies.sqlite', true],
      ['/u/.var/app/org.mozilla.firefox/.mozilla/firefox/x/cookies.sqlite', true], // Flatpak 装的
      ['/u/.var/app/com.google.Chrome/config/google-chrome/Default/Cookies', true],
      ['/u/snap/brave/current/.config/BraveSoftware/x', true],
      ['/u/code/proj/.env', true],
      ['/u/code/proj/.env.local', true],
      ['/u/code/proj/.envrc', true],
      ['/u/code/proj/.env.example', false],
      ['/u/code/proj/.env.sample', false],
      ['/u/code/proj/.env.template', false],
      ['/u/code/proj/prod.env', false],
      ['/u/code/proj/src/a.ts', false],
    ]);
  });

  it('macOS 的钥匙串与浏览器目录', () => {
    const mac = protectedLists({
      paths: derivePaths('/Users/u/.aalis', '/opt/aalis'),
      userHome: '/Users/u',
      platform: 'darwin',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'denyRead',
      [
        ['/Users/u/Library/Keychains/login.keychain-db', true],
        ['/Users/u/Library/Application Support/Google/Chrome/Default/Cookies', true],
        ['/Users/u/Library/Safari/History.db', true],
        ['/Users/u/Library/Application Support/Microsoft Edge Beta/Default/Cookies', true],
        ['/Users/u/Library/Application Support/com.operasoftware.OperaGX/Cookies', true],
        ['/Users/u/Library/Application Support/Code/User/settings.json', false],
      ],
      mac,
    );
  });
});

describe('用户家目录是根目录', () => {
  it('容器里没有 passwd 条目的用户 HOME 常是 /：凭据、shell 落点与其他实例的家目录照样命中', () => {
    const rooted = protectedLists({
      paths: derivePaths('/.aalis', '/opt/aalis'),
      userHome: '/',
      platform: 'linux',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'denyRead',
      [
        ['/.ssh/id_ed25519', true],
        ['/.aws/credentials', true],
        ['/.aalis-dev/x', true],
        ['/srv/a.txt', false],
      ],
      rooted,
    );
    expectHits('landing', [['/.bashrc', true]], rooted);
  });
});

describe('大小写与分隔符', () => {
  it('macOS 上不分大小写', () => {
    const mac = protectedLists({
      paths: derivePaths('/Users/u/.aalis', '/opt/aalis'),
      userHome: '/Users/u',
      platform: 'darwin',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'denyRead',
      [
        ['/users/U/.SSH/id_ed25519', true],
        ['/Users/u/code/p/.ENV', true],
        ['/USERS/U/.AALIS/SECRETS.YAML', true],
      ],
      mac,
    );
    expectHits(
      'landing',
      [
        ['/Users/u/code/p/.GIT/HOOKS/pre-commit', true],
        ['/Users/u/code/p/Agents.md', true],
      ],
      mac,
    );
    expectHits(
      'control',
      [
        ['/Users/u/.AALIS/state/db', true],
        ['/Users/u/.aalis/STAGE/PAPER/p/a.md', false],
      ],
      mac,
    );
  });

  it('Linux 上区分大小写：.GIT 不是 git 的目录', () => {
    expectHits('landing', [['/u/code/p/.GIT/hooks/pre-commit', false]]);
    expectHits('denyRead', [['/U/.ssh/id_ed25519', false]]);
  });

  it('Windows 上不分大小写，反斜杠与斜杠都认', () => {
    const win = protectedLists({
      paths: derivePaths('C:\\Users\\u\\.aalis', 'C:\\aalis'),
      userHome: 'C:\\Users\\u',
      platform: 'win32',
      form: 'source',
      codeDirs: [],
    });
    expectHits(
      'denyRead',
      [
        ['c:\\users\\U\\.ssh\\id_ed25519', true],
        ['C:/Users/u/.aalis/secrets.yaml', true],
      ],
      win,
    );
    expectHits('landing', [['D:\\code\\p\\.git\\hooks\\pre-commit', true]], win);
    expectHits(
      'control',
      [
        ['C:\\Users\\u\\.aalis\\state\\db', true],
        ['C:\\aalis\\packages\\core\\dist\\index.js', true],
      ],
      win,
    );
  });
});
