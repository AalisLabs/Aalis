import { useState, useEffect, useCallback } from 'react';
import { User, Crown, Command, Wrench, AlertTriangle } from 'lucide-react';
import { pageAction } from '../api';

interface AuthorityUser {
  platform: string;
  userId: string;
  authority: number;
}

interface AuthorityOwner {
  platform: string;
  userId: string;
}

interface AuthorityCommand {
  /** override 键 = path.join(':')；同时作为 React key */
  key: string;
  /** 同 key（兼容旧字段；React key 用 key） */
  name: string;
  /** 渲染显示，如 '/clear nuke' */
  displayName: string;
  /** 路径末段名 'nuke'，用于子行更紧凑展示 */
  leafName: string;
  /** 完整路径 */
  path: string[];
  /** 嵌套深度，根=0 */
  depth: number;
  isRoot: boolean;
  hasSubcommands: boolean;
  hasAction: boolean;
  description: string;
  authority: number;
  safety: string;
  baseAuthority: number;
  baseSafety: string;
  overridden: boolean;
  pluginName: string;
}

interface AuthorityTool {
  name: string;
  description: string;
  authority: number;
  safety: string;
  baseAuthority: number;
  baseSafety: string;
  overridden: boolean;
  pluginName: string;
}

interface AuthorityData {
  users: AuthorityUser[];
  owners: AuthorityOwner[];
  defaultAuthority: number;
  ownerAuthority: number;
  commandPrefix: string;
  commandAsTools: boolean;
  commands: AuthorityCommand[];
  commandOverrides: Record<string, { authority?: number; safety?: string }>;
  tools: AuthorityTool[];
  toolOverrides: Record<string, { authority?: number; safety?: string }>;
  dangerousPolicy: {
    allow?: string[];
    duration?: number;
    enabledAt?: number;
  };
}

export function AuthorityPage() {
  const [data, setData] = useState<AuthorityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['config']));
  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const [editConfig, setEditConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState({ defaultAuthority: 1, ownerAuthority: 5 });
  const [editDangerous, setEditDangerous] = useState(false);
  const [dangerousDraft, setDangerousDraft] = useState({ allow: '', duration: 0 });
  const [editUser, setEditUser] = useState<{ platform: string; userId: string; authority: number } | null>(null);
  const [newUser, setNewUser] = useState({ platform: '', userId: '', authority: 1 });
  const [showAddUser, setShowAddUser] = useState(false);
  const [newOwner, setNewOwner] = useState({ platform: '', userId: '' });
  const [showAddOwner, setShowAddOwner] = useState(false);
  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [cmdDraft, setCmdDraft] = useState({ authority: 1, safety: 'safe' });
  // 子指令展开状态：存储已展开的根指令 key（深度=0 的 key 即根名）
  const [expandedCmds, setExpandedCmds] = useState<Set<string>>(new Set());
  const toggleCmdExpand = (key: string) => {
    setExpandedCmds(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const [editingTool, setEditingTool] = useState<string | null>(null);
  const [toolDraft, setToolDraft] = useState({ authority: 1, safety: 'safe' });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await pageAction<AuthorityData>('@aalis/plugin-authority', 'getOverview');
      setData(d);
      setConfigDraft({ defaultAuthority: d.defaultAuthority, ownerAuthority: d.ownerAuthority });
      setDangerousDraft({
        allow: (d.dangerousPolicy?.allow ?? []).join(', '),
        duration: d.dangerousPolicy?.duration ?? 0,
      });
      // 自动展开"有任意后代被 override"的根指令，方便用户一眼看到自己的修改
      setExpandedCmds(prev => {
        const next = new Set(prev);
        for (const c of d.commands) {
          if (c.depth > 0 && c.overridden) {
            const rootKey = c.path[0];
            next.add(rootKey);
            // 同时展开沿途的所有祖先（孙级以上情况）
            for (let i = 1; i < c.path.length - 1; i++) {
              next.add(c.path.slice(0, i + 1).join(':'));
            }
          }
        }
        return next;
      });
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);

  // 倒计时：剩余秒数
  const [remainSec, setRemainSec] = useState<number | null>(null);

  useEffect(() => { refresh(); }, [refresh]);

  // 当 data 变化时启动 / 重置倒计时
  useEffect(() => {
    const policy = data?.dangerousPolicy;
    if (!policy?.enabledAt || !policy?.duration || policy.duration <= 0) {
      setRemainSec(null);
      return;
    }
    const calc = () => {
      const elapsed = (Date.now() - policy.enabledAt!) / 1000;
      const left = Math.max(0, Math.ceil(policy.duration! - elapsed));
      setRemainSec(left);
    };
    calc();
    const timer = setInterval(calc, 1000);
    return () => clearInterval(timer);
  }, [data?.dangerousPolicy]);

  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 2000);
  };

  const saveUserAuthority = async (platform: string, userId: string, authority: number) => {
    await pageAction('@aalis/plugin-authority', 'setUser', { platform, userId, authority });
    setEditUser(null);
    flash(`已设置 ${platform}:${userId} → ${authority}`);
    refresh();
  };
  const deleteUser = async (platform: string, userId: string) => {
    await pageAction('@aalis/plugin-authority', 'deleteUser', { platform, userId });
    flash(`已重置 ${platform}:${userId}`);
    refresh();
  };
  const addUser = async () => {
    if (!newUser.platform || !newUser.userId) return;
    await saveUserAuthority(newUser.platform, newUser.userId, newUser.authority);
    setNewUser({ platform: '', userId: '', authority: 1 });
    setShowAddUser(false);
  };

  const addOwner = async () => {
    if (!data || !newOwner.platform || !newOwner.userId) return;
    const owners = [...data.owners, { platform: newOwner.platform, userId: newOwner.userId }];
    await pageAction('@aalis/plugin-authority', 'setOwners', { owners });
    setNewOwner({ platform: '', userId: '' });
    setShowAddOwner(false);
    flash('Owner 已添加');
    refresh();
  };
  const removeOwner = async (idx: number) => {
    if (!data) return;
    const owners = data.owners.filter((_, i) => i !== idx);
    await pageAction('@aalis/plugin-authority', 'setOwners', { owners });
    flash('Owner 已移除');
    refresh();
  };

  const saveConfig = async () => {
    await pageAction('@aalis/plugin-authority', 'setConfig', configDraft);
    setEditConfig(false);
    flash('权限配置已保存');
    refresh();
  };
  const saveDangerous = async () => {
    const allow = dangerousDraft.allow.split(',').map(s => s.trim()).filter(Boolean);
    await pageAction('@aalis/plugin-authority', 'setDangerousPolicy', { policy: { allow, duration: dangerousDraft.duration } });
    setEditDangerous(false);
    flash('高危策略已保存');
    refresh();
  };

  const saveCommandOverride = async (name: string) => {
    await pageAction('@aalis/plugin-authority', 'setCommandOverride', { name, authority: cmdDraft.authority, safety: cmdDraft.safety });
    setEditingCmd(null);
    flash(`指令 ${name} 权限已更新`);
    refresh();
  };
  const resetCommandOverride = async (name: string) => {
    await pageAction('@aalis/plugin-authority', 'resetCommandOverride', { name });
    flash(`指令 ${name} 已恢复默认`);
    refresh();
  };

  const saveToolOverride = async (name: string) => {
    await pageAction('@aalis/plugin-authority', 'setToolOverride', { name, authority: toolDraft.authority, safety: toolDraft.safety });
    setEditingTool(null);
    flash(`工具 ${name} 权限已更新`);
    refresh();
  };
  const resetToolOverride = async (name: string) => {
    await pageAction('@aalis/plugin-authority', 'resetToolOverride', { name });
    flash(`工具 ${name} 已恢复默认`);
    refresh();
  };

  if (loading && !data) {
    return <div className="page-content"><div className="empty-hint">加载中...</div></div>;
  }
  if (!data) {
    return <div className="page-content"><div className="empty-hint">获取权限数据失败</div></div>;
  }

  return (
    <div className="page-content page-authority">
      {message && <div className="toast">{message}</div>}

      {/* 概览 */}
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon"><User size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册用户</div>
            <div className="overview-card-value">{data.users.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Crown size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">Owner 数</div>
            <div className="overview-card-value">{data.owners.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Command size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册指令</div>
            <div className="overview-card-value">{data.commands.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Wrench size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{data.tools?.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><AlertTriangle size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">高危白名单</div>
            <div className="overview-card-value">{data.dangerousPolicy?.allow?.length ?? 0}</div>
          </div>
        </div>
      </div>

      {/* 权限配置 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('config')}>
          <span className="config-block-title">权限配置</span>
          <span className="config-block-hint">控制新用户默认的权限等级及 Owner 的权限上限</span>
          <span className={`config-block-toggle ${openSections.has('config') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('config') && (
          <div className="config-block-body">
            {editConfig ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">defaultAuthority</label>
                  <input type="number" className="config-edit-input" min={0}
                    value={configDraft.defaultAuthority}
                    onChange={e => setConfigDraft(v => ({ ...v, defaultAuthority: parseInt(e.target.value) || 0 }))} />
                  <span className="config-edit-hint">新用户默认权限等级</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">ownerAuthority</label>
                  <input type="number" className="config-edit-input" min={1}
                    value={configDraft.ownerAuthority}
                    onChange={e => setConfigDraft(v => ({ ...v, ownerAuthority: parseInt(e.target.value) || 5 }))} />
                  <span className="config-edit-hint">Owner 用户权限等级</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveConfig}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditConfig(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">defaultAuthority</span>
                  <span className="val">{data.defaultAuthority}</span>
                </div>
                <div className="config-item">
                  <span className="key">ownerAuthority</span>
                  <span className="val">{data.ownerAuthority}</span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditConfig(true)}>编辑</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 指令权限 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('commands')}>
          <span className="config-block-title">指令权限</span>
          <span className="config-block-hint">自定义每条指令的所需权限等级与安全等级，修改后优先于插件默认值</span>
          <span className={`config-block-toggle ${openSections.has('commands') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('commands') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            {data.commands.length === 0 ? (
              <div className="empty-hint" style={{ padding: 12 }}>暂无已注册指令</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>指令</span>
                  <span>来源</span>
                  <span>权限等级</span>
                  <span>安全等级</span>
                  <span>操作</span>
                </div>
                {(() => {
                  // 根据 expandedCmds 过滤：未展开的根，跳过其所有后代
                  const rows: AuthorityCommand[] = [];
                  let skipPrefixDepth: number | null = null;
                  let skipPrefixPath: string[] | null = null;
                  for (const c of data.commands) {
                    if (skipPrefixPath && c.depth > skipPrefixDepth! &&
                        c.path.slice(0, skipPrefixPath.length).join(':') === skipPrefixPath.join(':')) {
                      continue; // 仍在被折叠的子树内
                    }
                    skipPrefixPath = null;
                    rows.push(c);
                    if (c.hasSubcommands && !expandedCmds.has(c.key)) {
                      skipPrefixDepth = c.depth;
                      skipPrefixPath = c.path;
                    }
                  }
                  return rows.map(c => {
                    const isEditing = editingCmd === c.key;
                    const isExpanded = expandedCmds.has(c.key);
                    return (
                      <div
                        className={`authority-cmd-row ${c.overridden ? 'overridden' : ''} ${c.depth > 0 ? 'is-sub' : ''}`}
                        style={c.depth > 0 ? { paddingLeft: 16 + c.depth * 18 } : undefined}
                        key={c.key}
                      >
                        <span className="authority-cmd-name" title={c.description}>
                          {c.hasSubcommands && (
                            <span
                              className={`authority-cmd-toggle ${isExpanded ? 'open' : ''}`}
                              onClick={() => toggleCmdExpand(c.key)}
                              title={isExpanded ? '折叠子指令' : '展开子指令'}
                              style={{ cursor: 'pointer', display: 'inline-block', width: 14, marginRight: 4, opacity: 0.6 }}
                            >▶</span>
                          )}
                          {c.depth === 0 ? c.displayName : c.leafName}
                          {c.hasSubcommands && !c.hasAction && (
                            <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.55 }}>(分组)</span>
                          )}
                        </span>
                        <span className="authority-cmd-plugin">
                          {c.depth === 0 ? c.pluginName : ''}
                        </span>
                        <span>
                          {isEditing ? (
                            <input type="number" className="config-edit-input authority-inline-input" min={0}
                              value={cmdDraft.authority}
                              onChange={e => setCmdDraft(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))}
                              autoFocus />
                          ) : (
                            <span className={`authority-badge ${c.authority >= data.ownerAuthority ? 'owner' : c.authority >= 3 ? 'high' : ''}`}>
                              {c.authority}
                            </span>
                          )}
                        </span>
                        <span>
                          {isEditing ? (
                            <select className="config-edit-input authority-inline-select"
                              value={cmdDraft.safety}
                              onChange={e => setCmdDraft(v => ({ ...v, safety: e.target.value }))}>
                              <option value="safe">safe</option>
                              <option value="dangerous">dangerous</option>
                            </select>
                          ) : (
                            <span className={`authority-safety-tag ${c.safety}`}>{c.safety}</span>
                          )}
                        </span>
                        <span className="authority-actions">
                          {isEditing ? (
                            <>
                              <button className="btn btn-primary btn-sm" onClick={() => saveCommandOverride(c.key)}>保存</button>
                              <button className="btn btn-sm" onClick={() => setEditingCmd(null)}>取消</button>
                            </>
                          ) : (
                            <>
                              <button className="btn btn-sm" onClick={() => {
                                setEditingCmd(c.key);
                                setCmdDraft({ authority: c.authority, safety: c.safety });
                              }}>编辑</button>
                              {c.overridden && (
                                <button className="btn btn-sm" onClick={() => resetCommandOverride(c.key)} title="恢复插件默认值">重置</button>
                              )}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 工具权限 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('tools')}>
          <span className="config-block-title">工具权限</span>
          <span className="config-block-hint">自定义每个 AI 工具的所需权限等级与安全等级，修改后优先于插件默认值</span>
          <span className={`config-block-toggle ${openSections.has('tools') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('tools') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            {!data.tools || data.tools.length === 0 ? (
              <div className="empty-hint" style={{ padding: 12 }}>暂无已注册工具</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>工具</span>
                  <span>来源</span>
                  <span>权限等级</span>
                  <span>安全等级</span>
                  <span>操作</span>
                </div>
                {data.tools.map(t => {
                  const isEditing = editingTool === t.name;
                  return (
                    <div className={`authority-cmd-row ${t.overridden ? 'overridden' : ''}`} key={t.name}>
                      <span className="authority-cmd-name" title={t.description}>
                        {t.name}
                      </span>
                      <span className="authority-cmd-plugin">{t.pluginName}</span>
                      <span>
                        {isEditing ? (
                          <input type="number" className="config-edit-input authority-inline-input" min={0}
                            value={toolDraft.authority}
                            onChange={e => setToolDraft(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))}
                            autoFocus />
                        ) : (
                          <span className={`authority-badge ${t.authority >= data.ownerAuthority ? 'owner' : t.authority >= 3 ? 'high' : ''}`}>
                            {t.authority}
                          </span>
                        )}
                      </span>
                      <span>
                        {isEditing ? (
                          <select className="config-edit-input authority-inline-select"
                            value={toolDraft.safety}
                            onChange={e => setToolDraft(v => ({ ...v, safety: e.target.value }))}>
                            <option value="safe">safe</option>
                            <option value="dangerous">dangerous</option>
                          </select>
                        ) : (
                          <span className={`authority-safety-tag ${t.safety}`}>{t.safety}</span>
                        )}
                      </span>
                      <span className="authority-actions">
                        {isEditing ? (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => saveToolOverride(t.name)}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditingTool(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => {
                              setEditingTool(t.name);
                              setToolDraft({ authority: t.authority, safety: t.safety });
                            }}>编辑</button>
                            {t.overridden && (
                              <button className="btn btn-sm" onClick={() => resetToolOverride(t.name)} title="恢复插件默认值">重置</button>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Owner 管理 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('owners')}>
          <span className="config-block-title">Owner 管理</span>
          <span className="config-block-hint">Owner 自动获得最高权限等级，WebUI 控制台始终为 Owner</span>
          <span className={`config-block-toggle ${openSections.has('owners') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('owners') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            <div style={{ padding: '8px 12px' }}>
              <button className="btn-sm" onClick={() => setShowAddOwner(!showAddOwner)}>
                {showAddOwner ? '取消' : '+ 添加 Owner'}
              </button>
            </div>
            {showAddOwner && (
              <div className="authority-add-form" style={{ padding: '0 12px 8px' }}>
                <input className="config-edit-input" placeholder="平台 (如 onebot)"
                  value={newOwner.platform} onChange={e => setNewOwner(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newOwner.userId} onChange={e => setNewOwner(v => ({ ...v, userId: e.target.value }))} />
                <button className="btn btn-primary btn-sm" onClick={addOwner} disabled={!newOwner.platform || !newOwner.userId}>确认</button>
              </div>
            )}
            {data.owners.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无 Owner。WebUI 控制台用户始终拥有最高权限。
              </div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header authority-owner-header">
                  <span>平台</span>
                  <span>用户 ID</span>
                  <span>操作</span>
                </div>
                {data.owners.map((o, idx) => (
                  <div className="authority-cmd-row authority-owner-row" key={`${o.platform}:${o.userId}`}>
                    <span className="authority-cell-platform">{o.platform}</span>
                    <span className="authority-cell-id">{o.userId}</span>
                    <span>
                      <button className="btn btn-danger btn-sm" onClick={() => removeOwner(idx)}>移除</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 用户权限 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('users')}>
          <span className="config-block-title">用户权限</span>
          <span className="config-block-hint">已自定义权限的用户列表，未列出的用户使用 defaultAuthority</span>
          <span className={`config-block-toggle ${openSections.has('users') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('users') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            <div style={{ padding: '8px 12px', display: 'flex', gap: 6 }}>
              <button className="btn-sm" onClick={() => setShowAddUser(!showAddUser)}>
                {showAddUser ? '取消' : '+ 添加用户'}
              </button>
              <button className="btn-sm" onClick={refresh} disabled={loading}>
                {loading ? '刷新中...' : '刷新'}
              </button>
            </div>
            {showAddUser && (
              <div className="authority-add-form" style={{ padding: '0 12px 8px' }}>
                <input className="config-edit-input" placeholder="平台 (如 onebot)"
                  value={newUser.platform} onChange={e => setNewUser(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newUser.userId} onChange={e => setNewUser(v => ({ ...v, userId: e.target.value }))} />
                <input className="config-edit-input" type="number" placeholder="权限等级" min={0}
                  value={newUser.authority} onChange={e => setNewUser(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))} />
                <button className="btn btn-primary btn-sm" onClick={addUser} disabled={!newUser.platform || !newUser.userId}>确认</button>
              </div>
            )}
            {data.users.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无已设置权限的用户。新用户将获得默认等级 {data.defaultAuthority}。
              </div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header authority-user-header">
                  <span>平台</span>
                  <span>用户 ID</span>
                  <span>权限等级</span>
                  <span>操作</span>
                </div>
                {data.users.map(u => {
                  const key = `${u.platform}:${u.userId}`;
                  const isEditing = editUser && editUser.platform === u.platform && editUser.userId === u.userId;
                  return (
                    <div className="authority-cmd-row authority-user-row" key={key}>
                      <span className="authority-cell-platform">{u.platform}</span>
                      <span className="authority-cell-id">{u.userId}</span>
                      <span>
                        {isEditing ? (
                          <input type="number" className="config-edit-input authority-inline-input" min={0}
                            value={editUser!.authority}
                            onChange={e => setEditUser(prev => prev ? { ...prev, authority: parseInt(e.target.value) || 0 } : null)}
                            autoFocus />
                        ) : (
                          <span className={`authority-badge ${u.authority >= data.ownerAuthority ? 'owner' : u.authority >= 3 ? 'high' : ''}`}>
                            {u.authority}
                          </span>
                        )}
                      </span>
                      <span className="authority-actions">
                        {isEditing ? (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => saveUserAuthority(editUser!.platform, editUser!.userId, editUser!.authority)}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditUser(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => setEditUser({ platform: u.platform, userId: u.userId, authority: u.authority })}>编辑</button>
                            <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u.platform, u.userId)}>重置</button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 高危操作策略 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('dangerous')}>
          <span className="config-block-title">高危操作策略</span>
          <span className="config-block-hint">控制哪些危险指令/工具允许执行，未在白名单中的 dangerous 操作会被拒绝</span>
          <span className={`config-block-toggle ${openSections.has('dangerous') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('dangerous') && (
          <div className="config-block-body">
            {editDangerous ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">allow</label>
                  <input className="config-edit-input"
                    value={dangerousDraft.allow}
                    onChange={e => setDangerousDraft(v => ({ ...v, allow: e.target.value }))}
                    placeholder="shutdown, restart 或 *" />
                  <span className="config-edit-hint">逗号分隔，* 表示全部放行</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">duration</label>
                  <input type="number" className="config-edit-input" min={0}
                    value={dangerousDraft.duration}
                    onChange={e => setDangerousDraft(v => ({ ...v, duration: parseInt(e.target.value) || 0 }))} />
                  <span className="config-edit-hint">有效期 (秒)，0 = 永久</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveDangerous}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditDangerous(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">allow</span>
                  <span className="val">{(data.dangerousPolicy?.allow ?? []).join(', ') || '(无)'}</span>
                </div>
                <div className="config-item">
                  <span className="key">duration</span>
                  <span className="val">
                    {data.dangerousPolicy?.duration === 0
                      ? '(永久)'
                      : remainSec != null
                        ? remainSec > 0
                          ? `${Math.floor(remainSec / 3600).toString().padStart(2, '0')}:${Math.floor((remainSec % 3600) / 60).toString().padStart(2, '0')}:${(remainSec % 60).toString().padStart(2, '0')} 剩余`
                          : '✕ 已过期'
                        : `${data.dangerousPolicy?.duration ?? 0}s (未激活)`
                    }
                  </span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditDangerous(true)}>编辑</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
