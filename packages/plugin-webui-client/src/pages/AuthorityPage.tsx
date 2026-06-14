import { useState, useEffect, useCallback } from 'react';
import { User, Crown, Command, Wrench, Clock } from 'lucide-react';
import { pageAction } from '../api';

interface AuthorityUser {
  platform: string;
  userId: string;
  isOwner: boolean;
  /** 被授予的受限能力（glob） */
  grant?: string[];
  /** 被拒绝的能力（glob；deny 压过一切，含 owner） */
  deny?: string[];
  /** 委托来源（上级身份键，如 webui:boss），构成委托树 */
  grantedBy?: string;
  /** 是否为可登录账户（已设密码） */
  hasPassword?: boolean;
  /** 本账户绑定的平台身份键（如 onebot:12345） */
  links?: string[];
  /** 本身份被绑定到的主账户键（如 webui:alice） */
  linkedTo?: string;
}

interface AuthorityOwner {
  platform: string;
  userId: string;
}

interface AuthorityCommand {
  key: string;
  name: string;
  displayName: string;
  visibility: 'public' | 'restricted';
}

interface AuthorityTool {
  key: string;
  name: string;
  visibility: 'public' | 'restricted';
}

interface TemporaryGrant {
  id: string;
  capability: string;
  name: string;
  type: 'command' | 'tool';
  sessionId: string;
  platform: string;
  userId?: string;
  expiresAt: number;
  maxUses?: number;
  used: number;
  createdAt: number;
}

interface Overview {
  users: AuthorityUser[];
  owners: AuthorityOwner[];
  platforms: string[];
  restrictedCapabilities: string[];
  deniedCapabilities: string[];
  visibilityOverrides: Record<string, 'public' | 'restricted'>;
  restrictedPolicy: { allow?: string[]; duration?: number };
  temporaryGrants: TemporaryGrant[];
  commandPrefix: string;
  commands: AuthorityCommand[];
  tools: AuthorityTool[];
}

const toList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AuthorityPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['users']));
  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // 用户与委托
  const [editCaps, setEditCaps] = useState<{ platform: string; userId: string; grant: string; deny: string } | null>(null);
  const [editPwd, setEditPwd] = useState<{ platform: string; userId: string; password: string } | null>(null);
  const [bindCode, setBindCode] = useState<{ code: string; hint: string } | null>(null);
  const [newUser, setNewUser] = useState({ platform: '', userId: '', grant: '', deny: '' });
  const [showAddUser, setShowAddUser] = useState(false);

  // Owner
  const [newOwner, setNewOwner] = useState({ platform: '', userId: '' });
  const [showAddOwner, setShowAddOwner] = useState(false);

  // 受限 / 禁用能力清单
  const [editCapsList, setEditCapsList] = useState(false);
  const [capsDraft, setCapsDraft] = useState({ restricted: '', denied: '' });

  // 临时放行策略
  const [editPolicy, setEditPolicy] = useState(false);
  const [policyDraft, setPolicyDraft] = useState({ allow: '', duration: 0 });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await pageAction<Overview>('@aalis/plugin-authority', 'getOverview');
      setData(d);
      setCapsDraft({
        restricted: (d.restrictedCapabilities ?? []).join(', '),
        denied: (d.deniedCapabilities ?? []).join(', '),
      });
      setPolicyDraft({
        allow: (d.restrictedPolicy?.allow ?? []).join(', '),
        duration: d.restrictedPolicy?.duration ?? 0,
      });
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 2000);
  };

  // ---- 用户与委托 ----
  const saveUserCapabilities = async () => {
    if (!editCaps) return;
    try {
      await pageAction('@aalis/plugin-authority', 'setUserCapabilities', {
        platform: editCaps.platform, userId: editCaps.userId,
        grant: toList(editCaps.grant), deny: toList(editCaps.deny),
      });
      flash(`已更新 ${editCaps.platform}:${editCaps.userId} 的委托`);
      setEditCaps(null);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const saveUserPassword = async () => {
    if (!editPwd) return;
    try {
      await pageAction('@aalis/plugin-authority', 'setPassword', {
        platform: editPwd.platform, userId: editPwd.userId, password: editPwd.password,
      });
      flash(`已更新 ${editPwd.platform}:${editPwd.userId} 的密码`);
      setEditPwd(null);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const deleteUser = async (platform: string, userId: string) => {
    try {
      await pageAction('@aalis/plugin-authority', 'deleteUser', { platform, userId });
      flash(`已删除 ${platform}:${userId}`);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const addUser = async () => {
    if (!newUser.platform || !newUser.userId) return;
    try {
      await pageAction('@aalis/plugin-authority', 'setUserCapabilities', {
        platform: newUser.platform, userId: newUser.userId,
        grant: toList(newUser.grant), deny: toList(newUser.deny),
      });
      flash(`已添加 ${newUser.platform}:${newUser.userId}`);
      setNewUser({ platform: '', userId: '', grant: '', deny: '' });
      setShowAddUser(false);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const generateBindCode = async () => {
    try {
      const r = await pageAction<{ code: string; hint: string }>('@aalis/plugin-authority', 'createBindCode');
      setBindCode(r);
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const unlinkIdentity = async (platform: string, userId: string) => {
    try {
      await pageAction('@aalis/plugin-authority', 'unlinkIdentity', { platform, userId });
      flash(`已解绑 ${platform}:${userId}`);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  // ---- Owner ----
  const addOwner = async () => {
    if (!data || !newOwner.platform || !newOwner.userId) return;
    try {
      const owners = [...data.owners, { platform: newOwner.platform, userId: newOwner.userId }];
      await pageAction('@aalis/plugin-authority', 'setOwners', { owners });
      setNewOwner({ platform: '', userId: '' });
      setShowAddOwner(false);
      flash('Owner 已添加');
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const removeOwner = async (idx: number) => {
    if (!data) return;
    try {
      const owners = data.owners.filter((_, i) => i !== idx);
      await pageAction('@aalis/plugin-authority', 'setOwners', { owners });
      flash('Owner 已移除');
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  // ---- 可见性覆盖 ----
  const setVisibility = async (name: string, visibility: 'public' | 'restricted' | '') => {
    try {
      await pageAction('@aalis/plugin-authority', 'setVisibilityOverride', { name, visibility });
      flash(visibility ? `${name} → ${visibility}` : `${name} 已恢复默认`);
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  // ---- 受限 / 禁用能力清单 ----
  const saveCapsList = async () => {
    try {
      await pageAction('@aalis/plugin-authority', 'setConfig', {
        restrictedCapabilities: toList(capsDraft.restricted),
        deniedCapabilities: toList(capsDraft.denied),
      });
      setEditCapsList(false);
      flash('能力清单已保存');
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  // ---- 临时放行策略 ----
  const savePolicy = async () => {
    try {
      await pageAction('@aalis/plugin-authority', 'setRestrictedPolicy', {
        policy: { allow: toList(policyDraft.allow), duration: policyDraft.duration },
      });
      setEditPolicy(false);
      flash('临时放行策略已保存');
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  const revokeTemporaryGrant = async (id: string) => {
    try {
      await pageAction('@aalis/plugin-authority', 'revokeTemporaryGrant', { id });
      flash('已撤销临时委托');
      refresh();
    } catch (err) {
      flash(errMsg(err));
    }
  };

  if (loading && !data) {
    return <div className="page-content"><div className="empty-hint">加载中...</div></div>;
  }
  if (!data) {
    return <div className="page-content"><div className="empty-hint">获取权限数据失败</div></div>;
  }

  const renderVisibilityRow = (
    row: { key: string; name: string; displayName?: string; visibility: 'public' | 'restricted' },
  ) => {
    const overridden = Object.prototype.hasOwnProperty.call(data.visibilityOverrides, row.name);
    return (
      <div className={`authority-cmd-row ${overridden ? 'overridden' : ''}`} key={row.key}>
        <span className="authority-cmd-name" title={row.name}>
          {row.displayName ?? row.name}
          {overridden && (
            <span style={{ marginLeft: 4, color: '#f59e0b', fontSize: 11 }} title="已被 owner 覆盖（非插件默认）">●</span>
          )}
        </span>
        <span>
          <span className={`authority-safety-tag ${row.visibility}`}>{row.visibility}</span>
        </span>
        <span className="authority-actions">
          <button
            className={`btn btn-sm ${row.visibility === 'public' ? 'btn-primary' : ''}`}
            onClick={() => setVisibility(row.name, 'public')}
            title="任何人默认可用"
          >public</button>
          <button
            className={`btn btn-sm ${row.visibility === 'restricted' ? 'btn-primary' : ''}`}
            onClick={() => setVisibility(row.name, 'restricted')}
            title="默认禁用，需显式授予"
          >restricted</button>
          {overridden && (
            <button className="btn btn-sm" onClick={() => setVisibility(row.name, '')} title="恢复插件声明的默认可见性">默认</button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="page-content page-authority">
      {message && <div className="toast">{message}</div>}

      {/* 平台候选项 */}
      <datalist id="authority-platforms">
        {(data.platforms ?? []).map(p => <option key={p} value={p} />)}
      </datalist>

      {/* 概览 */}
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon"><User size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">用户</div>
            <div className="overview-card-value">{data.users.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Crown size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">Owner</div>
            <div className="overview-card-value">{data.owners.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Command size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">指令</div>
            <div className="overview-card-value">{data.commands.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Wrench size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">工具</div>
            <div className="overview-card-value">{data.tools.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Clock size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">临时委托</div>
            <div className="overview-card-value">{data.temporaryGrants.length}</div>
          </div>
        </div>
      </div>

      {/* 用户与委托 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('users')}>
          <span className="config-block-title">用户与委托</span>
          <span className="config-block-hint">为用户授予受限能力或拒绝能力（glob）；deny &gt; owner(*) &gt; public &gt; grant</span>
          <span className={`config-block-toggle ${openSections.has('users') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('users') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            <div style={{ padding: '8px 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn-sm" onClick={() => setShowAddUser(!showAddUser)}>
                {showAddUser ? '取消' : '+ 添加用户'}
              </button>
              <button className="btn-sm" title="为当前登录账户生成跨平台绑定码（绑定 QQ 等外部身份）"
                onClick={generateBindCode}>绑定平台身份</button>
              <button className="btn-sm" onClick={refresh} disabled={loading}>
                {loading ? '刷新中...' : '刷新'}
              </button>
            </div>
            {bindCode && (
              <div className="authority-user-expand" style={{ borderTop: '1px solid var(--border)' }}>
                <label>绑定码（一次性，限时有效；重复生成会作废旧码）</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 18, letterSpacing: 2 }}>{bindCode.code}</code>
                  <button className="btn-sm" onClick={() => setBindCode(null)}>关闭</button>
                </div>
                <label>{bindCode.hint}</label>
              </div>
            )}
            {showAddUser && (
              <div className="authority-add-form" style={{ padding: '0 12px 8px' }}>
                <input className="config-edit-input" placeholder="平台 (如 onebot / webui)"
                  list="authority-platforms"
                  value={newUser.platform} onChange={e => setNewUser(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newUser.userId} onChange={e => setNewUser(v => ({ ...v, userId: e.target.value }))} />
                <input className="config-edit-input" placeholder="授予 grant（逗号分隔 glob，可空）"
                  title="如 tool:file.*, command:deploy"
                  value={newUser.grant} onChange={e => setNewUser(v => ({ ...v, grant: e.target.value }))} />
                <input className="config-edit-input" placeholder="拒绝 deny（逗号分隔 glob，可空）"
                  title="如 tool:shell.*"
                  value={newUser.deny} onChange={e => setNewUser(v => ({ ...v, deny: e.target.value }))} />
                <button className="btn btn-primary btn-sm" onClick={addUser}
                  disabled={!newUser.platform || !newUser.userId}>确认</button>
              </div>
            )}
            {data.users.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无用户记录。public 能力对所有人默认开放，无需登记。
              </div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header authority-user-header">
                  <span>平台</span>
                  <span>身份 / 委托</span>
                  <span>操作</span>
                </div>
                {data.users.map(u => {
                  const key = `${u.platform}:${u.userId}`;
                  const isCapsOpen = editCaps && editCaps.platform === u.platform && editCaps.userId === u.userId;
                  const isPwdOpen = editPwd && editPwd.platform === u.platform && editPwd.userId === u.userId;
                  const grantN = u.grant?.length ?? 0;
                  const denyN = u.deny?.length ?? 0;
                  return (
                    <div key={key}>
                      <div className="authority-cmd-row authority-user-row">
                        <span className="authority-cell-platform">{u.platform}</span>
                        <span className="authority-cell-id">
                          {u.userId}
                          {u.isOwner && <span className="authority-user-flag owner" title="Owner（拥有全部能力 *）">owner</span>}
                          {u.hasPassword && <span className="authority-user-flag" title="可登录账户（已设密码）">账户</span>}
                          {(grantN || denyN) ? (
                            <span className="authority-user-flag" title={`授予: ${(u.grant ?? []).join(', ') || '无'}\n拒绝: ${(u.deny ?? []).join(', ') || '无'}`}>
                              +{grantN} / −{denyN}
                            </span>
                          ) : null}
                          {u.grantedBy && (
                            <span className="authority-user-flag" title="委托来源（上级授予者），构成委托树">
                              委托自 {u.grantedBy}
                            </span>
                          )}
                          {u.linkedTo && (
                            <span className="authority-user-flag" title={`已绑定到主账户 ${u.linkedTo}：运行时以账户身份解析（解绑后还原）`}>
                              → {u.linkedTo}
                            </span>
                          )}
                          {u.links?.map(link => (
                            <span key={link} className="authority-user-flag" title="已绑定的平台身份（运行时解析到本账户）">
                              ⇄ {link}
                              <button className="authority-unlink-btn" title="解绑"
                                onClick={() => {
                                  const idx = link.indexOf(':');
                                  unlinkIdentity(link.slice(0, idx), link.slice(idx + 1));
                                }}>×</button>
                            </span>
                          ))}
                        </span>
                        <span className="authority-actions">
                          <button className="btn btn-sm" title="设置该用户的授予 / 拒绝能力（委托）"
                            onClick={() => setEditCaps(isCapsOpen ? null : {
                              platform: u.platform, userId: u.userId,
                              grant: (u.grant ?? []).join(', '), deny: (u.deny ?? []).join(', '),
                            })}>能力</button>
                          <button className="btn btn-sm" title={u.hasPassword ? '重置登录密码' : '设置登录密码（platform=webui 时可登录 WebUI）'}
                            onClick={() => setEditPwd(isPwdOpen ? null : { platform: u.platform, userId: u.userId, password: '' })}>密码</button>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u.platform, u.userId)}>删除</button>
                        </span>
                      </div>
                      {isCapsOpen && (
                        <div className="authority-user-expand">
                          <label>grant — 授予的受限能力（逗号分隔 glob）</label>
                          <input className="config-edit-input" placeholder="如 tool:file.*, action:@aalis/plugin-x:method, *"
                            value={editCaps!.grant}
                            onChange={e => setEditCaps(prev => prev ? { ...prev, grant: e.target.value } : null)} autoFocus />
                          <label>deny — 拒绝的能力（压过 grant 与 owner）</label>
                          <input className="config-edit-input" placeholder="如 tool:shell.*, command:shutdown"
                            value={editCaps!.deny}
                            onChange={e => setEditCaps(prev => prev ? { ...prev, deny: e.target.value } : null)} />
                          <div className="config-edit-actions">
                            <button className="btn btn-primary btn-sm" onClick={saveUserCapabilities}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditCaps(null)}>取消</button>
                          </div>
                        </div>
                      )}
                      {isPwdOpen && (
                        <div className="authority-user-expand">
                          <label>{u.hasPassword ? '重置密码（≥6 位）' : '设置密码（≥6 位；platform=webui 时用户 ID 即登录用户名）'}</label>
                          <input className="config-edit-input" type="password" autoComplete="new-password"
                            value={editPwd!.password}
                            onChange={e => setEditPwd(prev => prev ? { ...prev, password: e.target.value } : null)} autoFocus />
                          <div className="config-edit-actions">
                            <button className="btn btn-primary btn-sm" onClick={saveUserPassword} disabled={editPwd!.password.length < 6}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditPwd(null)}>取消</button>
                          </div>
                        </div>
                      )}
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
          <span className="config-block-hint">Owner 拥有全部能力（*）；console（单 token 登录）恒为 Owner</span>
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
                  list="authority-platforms"
                  value={newOwner.platform} onChange={e => setNewOwner(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newOwner.userId} onChange={e => setNewOwner(v => ({ ...v, userId: e.target.value }))} />
                <button className="btn btn-primary btn-sm" onClick={addOwner} disabled={!newOwner.platform || !newOwner.userId}>确认</button>
              </div>
            )}
            {data.owners.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无显式 Owner。console（单 token 登录）始终拥有全部能力。
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

      {/* 指令可见性 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('commands')}>
          <span className="config-block-title">指令可见性</span>
          <span className="config-block-hint">public = 默认任何人可用；restricted = 默认禁用需授予。Owner 可覆盖单条声明</span>
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
                  <span>可见性</span>
                  <span>操作</span>
                </div>
                {data.commands.map(c => renderVisibilityRow(c))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 工具可见性 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('tools')}>
          <span className="config-block-title">工具可见性</span>
          <span className="config-block-hint">AI 工具的默认可见性；Owner 可覆盖单个工具的声明</span>
          <span className={`config-block-toggle ${openSections.has('tools') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('tools') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            {data.tools.length === 0 ? (
              <div className="empty-hint" style={{ padding: 12 }}>暂无已注册工具</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>工具</span>
                  <span>可见性</span>
                  <span>操作</span>
                </div>
                {data.tools.map(t => renderVisibilityRow(t))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 受限 / 禁用能力清单 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('caps')}>
          <span className="config-block-title">受限 / 禁用能力清单</span>
          <span className="config-block-hint">在内置之外追加的能力 glob 规则</span>
          <span className={`config-block-toggle ${openSections.has('caps') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('caps') && (
          <div className="config-block-body">
            {editCapsList ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">restricted</label>
                  <input className="config-edit-input"
                    value={capsDraft.restricted}
                    onChange={e => setCapsDraft(v => ({ ...v, restricted: e.target.value }))}
                    placeholder="tool:shell.*, command:deploy" />
                  <span className="config-edit-hint">额外按受限处理（默认禁，需授予）</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">denied</label>
                  <input className="config-edit-input"
                    value={capsDraft.denied}
                    onChange={e => setCapsDraft(v => ({ ...v, denied: e.target.value }))}
                    placeholder="tool:dangerous.*" />
                  <span className="config-edit-hint">全局硬禁，连 owner 都压过；慎用</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveCapsList}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditCapsList(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item" title="额外按受限处理：默认禁用，需显式授予">
                  <span className="key">restrictedCapabilities</span>
                  <span className="val">{(data.restrictedCapabilities ?? []).join(', ') || '(无)'}</span>
                </div>
                <div className="config-item" title="全局硬禁：覆盖一切，连 owner 都压过；慎用">
                  <span className="key">deniedCapabilities</span>
                  <span className="val">{(data.deniedCapabilities ?? []).join(', ') || '(无)'}</span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditCapsList(true)}>编辑</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 临时放行策略 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('policy')}>
          <span className="config-block-title">临时放行策略</span>
          <span className="config-block-hint">受限能力的临时自动放行白名单，及当前活跃的临时委托</span>
          <span className={`config-block-toggle ${openSections.has('policy') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('policy') && (
          <div className="config-block-body">
            {editPolicy ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">allow</label>
                  <input className="config-edit-input"
                    value={policyDraft.allow}
                    onChange={e => setPolicyDraft(v => ({ ...v, allow: e.target.value }))}
                    placeholder="command:deploy, tool:file.* 或 *" />
                  <span className="config-edit-hint">逗号分隔 glob，* 表示全部受限能力</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">duration</label>
                  <input type="number" className="config-edit-input" min={0}
                    value={policyDraft.duration}
                    onChange={e => setPolicyDraft(v => ({ ...v, duration: parseInt(e.target.value) || 0 }))} />
                  <span className="config-edit-hint">有效期 (秒)，0 = 永久</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={savePolicy}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditPolicy(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">allow</span>
                  <span className="val">{(data.restrictedPolicy?.allow ?? []).join(', ') || '(无)'}</span>
                </div>
                <div className="config-item">
                  <span className="key">duration</span>
                  <span className="val">{data.restrictedPolicy?.duration === 0 ? '(永久)' : `${data.restrictedPolicy?.duration ?? 0}s`}</span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditPolicy(true)}>编辑</button>
                </div>
              </>
            )}

            <div className="section-label" style={{ marginTop: 12 }}>当前临时委托</div>
            {data.temporaryGrants.length === 0 ? (
              <div className="empty-hint" style={{ padding: '4px 0' }}>暂无活跃的临时委托。</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>能力 / 会话</span>
                  <span>用量</span>
                  <span>操作</span>
                </div>
                {data.temporaryGrants.map(g => (
                  <div className="authority-cmd-row" key={g.id}>
                    <span className="authority-cmd-name" title={`类型 ${g.type} · 平台 ${g.platform}${g.userId ? ':' + g.userId : ''} · 到期 ${new Date(g.expiresAt).toLocaleString()}`}>
                      {g.capability}
                      <span className="authority-cmd-plugin" style={{ marginLeft: 6 }}>{g.sessionId}</span>
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>
                      {g.used}{g.maxUses ? ` / ${g.maxUses}` : ''}
                    </span>
                    <span className="authority-actions">
                      <button className="btn btn-danger btn-sm" onClick={() => revokeTemporaryGrant(g.id)}>撤销</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
