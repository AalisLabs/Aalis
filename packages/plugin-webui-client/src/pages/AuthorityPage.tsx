import { Clock, Crown, SlidersHorizontal, User, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { pageAction } from '../api';
import {
  type ConfirmOverride,
  type Operation,
  type Preset,
  type Vis,
  capKey,
  detectPreset,
  effectiveConfirm,
  effectiveVisibility,
  groupByPlugin,
  groupVisibility,
  PRESET_LABEL,
  presetToCaps,
} from './authority-page-util.js';
import { buildCaps, type CapState, splitCaps } from './capability-picker-util.js';

const PLUGIN = '@aalis/plugin-authority';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toList = (s: string) =>
  s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

interface AuthorityUser {
  platform: string;
  userId: string;
  isOwner: boolean;
  grant?: string[];
  deny?: string[];
}
interface Owner {
  platform: string;
  userId: string;
}
interface TemporaryGrant {
  id: string;
  capability: string;
  sessionId: string;
  used: number;
  maxUses?: number;
}
interface Overview {
  users: AuthorityUser[];
  owners: Owner[];
  platforms: string[];
  deniedCapabilities: string[];
  visibilityOverrides: Record<string, Vis>;
  confirmOverrides: Record<string, ConfirmOverride>;
  restrictedPolicy: { allow?: string[]; duration?: number };
  temporaryGrants: TemporaryGrant[];
  commandPrefix: string;
  commands: Operation[];
  tools: Operation[];
}

/** 三态/多态按钮组（当前值高亮）。所有按钮都有 onClick，绝不空转。 */
function SegButtons<T extends string>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: Array<{ v: T; label: string }>;
  onPick: (v: T) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          className={`btn btn-sm${value === o.v ? ' btn-primary' : ''}`}
          onClick={() => onPick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

// ════════════════════ 用户能力编辑器（按插件分组 + 整组 + 高级 glob）════════════════════
function UserCapEditor({
  ops,
  initialGrant,
  initialDeny,
  onSave,
  onCancel,
}: {
  ops: Operation[];
  initialGrant: string[];
  initialDeny: string[];
  onSave: (grant: string[], deny: string[]) => void;
  onCancel: () => void;
}) {
  const knownIds = new Set(ops.map(capKey));
  const init = splitCaps(initialGrant.join(','), initialDeny.join(','), knownIds);
  const [caps, setCaps] = useState<Record<string, CapState>>(() => init.caps);
  const [advGrant, setAdvGrant] = useState(() => init.advGrant);
  const [advDeny, setAdvDeny] = useState(() => init.advDeny);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const groups = groupByPlugin(ops);
  const ql = q.trim().toLowerCase();

  const setOne = (id: string, st: CapState | 'default') => {
    setCaps(prev => {
      const next = { ...prev };
      if (st === 'default') delete next[id];
      else next[id] = st;
      return next;
    });
  };
  const setGroup = (groupOps: Operation[], st: CapState | 'default') => {
    setCaps(prev => {
      const next = { ...prev };
      for (const op of groupOps) {
        const id = capKey(op);
        if (st === 'default') delete next[id];
        else next[id] = st;
      }
      return next;
    });
  };

  const save = () => {
    const { grant, deny } = buildCaps(caps, advGrant, advDeny);
    onSave(toList(grant), toList(deny));
  };

  return (
    <div className="authority-user-expand">
      <input
        className="config-edit-input"
        placeholder="搜索插件 / 操作…"
        value={q}
        onChange={e => setQ(e.target.value)}
      />
      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, margin: '6px 0' }}>
        {groups.map(({ plugin, ops: groupOps }) => {
          const shown = groupOps.filter(
            op => !ql || op.pluginName.toLowerCase().includes(ql) || op.displayName.toLowerCase().includes(ql),
          );
          if (shown.length === 0) return null;
          const isOpen = open.has(plugin) || ql.length > 0;
          return (
            <div key={plugin} style={{ borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ flex: 1, textAlign: 'left', minWidth: 0 }}
                  onClick={() =>
                    setOpen(prev => {
                      const n = new Set(prev);
                      n.has(plugin) ? n.delete(plugin) : n.add(plugin);
                      return n;
                    })
                  }
                >
                  {isOpen ? '▾' : '▸'} {plugin} <span style={{ opacity: 0.5 }}>({shown.length})</span>
                </button>
                <span style={{ opacity: 0.6, fontSize: 11 }}>整组</span>
                <SegButtons<CapState | 'default'>
                  value={'default'}
                  options={[
                    { v: 'default', label: '默认' },
                    { v: 'grant', label: '授予' },
                    { v: 'deny', label: '拒绝' },
                  ]}
                  onPick={st => setGroup(shown, st)}
                />
              </div>
              {isOpen &&
                shown.map(op => {
                  const id = capKey(op);
                  const st = (caps[id] ?? 'default') as CapState | 'default';
                  return (
                    <div
                      key={id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px 3px 24px' }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ opacity: 0.5, fontSize: 11, marginRight: 4 }}>{op.type === 'command' ? '令' : '具'}</span>
                        {op.displayName}
                      </span>
                      <SegButtons<CapState | 'default'>
                        value={st}
                        options={[
                          { v: 'default', label: '默认' },
                          { v: 'grant', label: '授予' },
                          { v: 'deny', label: '拒绝' },
                        ]}
                        onPick={s => setOne(id, s)}
                      />
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      <label className="config-block-hint">高级 · grant（通配 / 存储等 glob，逗号分隔）</label>
      <input className="config-edit-input" placeholder="如 tool:file.*, storage:*" value={advGrant} onChange={e => setAdvGrant(e.target.value)} />
      <label className="config-block-hint">高级 · deny（压过 grant 与 owner）</label>
      <input className="config-edit-input" placeholder="如 tool:shell.*" value={advDeny} onChange={e => setAdvDeny(e.target.value)} />
      <div className="config-edit-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={save}>
          保存
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export function AuthorityPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const flash = (m: string) => {
    setMessage(m);
    setTimeout(() => setMessage(''), 2200);
  };

  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['ops', 'users']));
  const toggleSection = (k: string) =>
    setOpenSections(prev => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const [opQuery, setOpQuery] = useState('');
  const [openPlugins, setOpenPlugins] = useState<Set<string>>(new Set());
  const [editUser, setEditUser] = useState<string | null>(null); // "platform:userId"
  const [newUser, setNewUser] = useState({ platform: '', userId: '' });
  const [newOwner, setNewOwner] = useState({ platform: '', userId: '' });
  const [showAddOwner, setShowAddOwner] = useState(false);
  const [advDraft, setAdvDraft] = useState({ denied: '', allow: '', duration: 0 });
  const [editAdv, setEditAdv] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await pageAction<Overview>(PLUGIN, 'getOverview');
      setData(d);
      setAdvDraft({
        denied: (d.deniedCapabilities ?? []).join(', '),
        allow: (d.restrictedPolicy?.allow ?? []).join(', '),
        duration: d.restrictedPolicy?.duration ?? 0,
      });
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 调 action：失败 flash 错误，成功 flash 提示并刷新。 */
  const act = useCallback(
    async (method: string, args: Record<string, unknown>, okMsg?: string) => {
      try {
        await pageAction(PLUGIN, method, args);
        if (okMsg) flash(okMsg);
        await refresh();
      } catch (e) {
        flash(errMsg(e));
      }
    },
    [refresh],
  );

  if (loading && !data) {
    return (
      <div className="page-content">
        <div className="empty-hint">加载中...</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-content">
        <div className="empty-hint">获取权限数据失败</div>
      </div>
    );
  }

  const ops: Operation[] = [...data.commands, ...data.tools];
  const opGroups = groupByPlugin(ops);
  const ql = opQuery.trim().toLowerCase();
  const users = data.users.filter(u => !u.isOwner);

  // ── 操作：可见性 / 确认覆盖 ──
  const setOpVisibility = (op: Operation, v: Vis | '') => act('setVisibilityOverride', { name: capKey(op), visibility: v }, '已更新可见性');
  const setOpConfirm = (op: Operation, c: ConfirmOverride | '') => act('setConfirmOverride', { name: capKey(op), confirm: c }, '已更新确认');
  const setGroupVisibility = async (groupOps: Operation[], v: Vis) => {
    try {
      await Promise.all(groupOps.map(op => pageAction(PLUGIN, 'setVisibilityOverride', { name: capKey(op), visibility: v })));
      flash('整组可见性已更新');
      await refresh();
    } catch (e) {
      flash(errMsg(e));
    }
  };

  // ── 用户 ──
  const applyPreset = (u: AuthorityUser, preset: Exclude<Preset, 'custom'>) => {
    const caps = presetToCaps(preset);
    act('setUserCapabilities', { platform: u.platform, userId: u.userId, grant: caps.grant, deny: caps.deny }, `已设为「${PRESET_LABEL[preset]}」`);
  };
  const saveUserCaps = (u: AuthorityUser, grant: string[], deny: string[]) => {
    setEditUser(null);
    act('setUserCapabilities', { platform: u.platform, userId: u.userId, grant, deny }, `已更新 ${u.platform}:${u.userId}`);
  };

  return (
    <div className="page-content page-authority">
      {message && <div className="toast">{message}</div>}
      <datalist id="authority-platforms">
        {(data.platforms ?? []).map(p => (
          <option key={p} value={p} />
        ))}
      </datalist>

      {/* 概览 */}
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon"><Wrench size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">操作</div>
            <div className="overview-card-value">{ops.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><User size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">用户</div>
            <div className="overview-card-value">{users.length}</div>
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
          <div className="overview-card-icon"><Clock size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">临时放行</div>
            <div className="overview-card-value">{data.temporaryGrants.length}</div>
          </div>
        </div>
      </div>

      {/* ═══ 操作 ═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('ops')}>
          <span className="config-block-title">操作（指令 / 工具的默认权限）</span>
          <span className="config-block-hint">公开=人人可用；受限=默认禁需授予。确认=执行前需人点头。Owner 可逐条或整组覆盖。</span>
          <span className={`config-block-toggle ${openSections.has('ops') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('ops') && (
          <div className="config-block-body">
            <input className="config-edit-input" placeholder="搜索插件 / 操作…" value={opQuery} onChange={e => setOpQuery(e.target.value)} />
            {opGroups.map(({ plugin, ops: groupOps }) => {
              const shown = groupOps.filter(op => !ql || op.pluginName.toLowerCase().includes(ql) || op.displayName.toLowerCase().includes(ql));
              if (shown.length === 0) return null;
              const isOpen = openPlugins.has(plugin) || ql.length > 0;
              const gvis = groupVisibility(shown, data.visibilityOverrides);
              return (
                <div key={plugin} className="authority-cmd-list" style={{ marginTop: 6 }}>
                  <div className="authority-cmd-row" style={{ background: 'var(--surface)' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flex: 1, textAlign: 'left' }}
                      onClick={() =>
                        setOpenPlugins(prev => {
                          const n = new Set(prev);
                          n.has(plugin) ? n.delete(plugin) : n.add(plugin);
                          return n;
                        })
                      }
                    >
                      {isOpen ? '▾' : '▸'} {plugin} <span style={{ opacity: 0.5 }}>({shown.length})</span>
                      {gvis !== 'mixed' && <span className={`authority-safety-tag ${gvis}`} style={{ marginLeft: 6 }}>{gvis}</span>}
                    </button>
                    <span style={{ opacity: 0.6, fontSize: 11, marginRight: 4 }}>整组</span>
                    <SegButtons<Vis>
                      value={gvis === 'mixed' ? ('' as Vis) : gvis}
                      options={[
                        { v: 'public', label: '公开' },
                        { v: 'restricted', label: '受限' },
                      ]}
                      onPick={v => setGroupVisibility(shown, v)}
                    />
                  </div>
                  {isOpen &&
                    shown.map(op => {
                      const k = capKey(op);
                      const vis = effectiveVisibility(op, data.visibilityOverrides);
                      const conf = effectiveConfirm(op, data.confirmOverrides);
                      const visOverridden = k in data.visibilityOverrides;
                      const confOv = data.confirmOverrides[k];
                      return (
                        <div className="authority-cmd-row authority-user-row" key={k}>
                          <span className="authority-cmd-name" title={k}>
                            <span style={{ opacity: 0.5, fontSize: 11, marginRight: 4 }}>{op.type === 'command' ? '令' : '具'}</span>
                            {op.displayName}
                            {visOverridden && <span style={{ color: '#f59e0b', marginLeft: 4 }} title="已被 owner 覆盖">●</span>}
                          </span>
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <SegButtons<Vis | 'default'>
                              value={visOverridden ? vis : 'default'}
                              options={[
                                { v: 'default', label: '默认' },
                                { v: 'public', label: '公开' },
                                { v: 'restricted', label: '受限' },
                              ]}
                              onPick={v => setOpVisibility(op, v === 'default' ? '' : v)}
                            />
                            <span style={{ opacity: 0.4 }}>|</span>
                            <SegButtons<ConfirmOverride | 'default'>
                              value={confOv ?? 'default'}
                              options={[
                                { v: 'default', label: conf ? `默认(${conf === 'always' ? '每次' : '会话'})` : '默认' },
                                { v: 'off', label: '关' },
                                { v: 'session', label: '会话' },
                                { v: 'always', label: '每次' },
                              ]}
                              onPick={c => setOpConfirm(op, c === 'default' ? '' : c)}
                            />
                          </span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══ 用户 ═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('users')}>
          <span className="config-block-title">用户（外部身份的权限）</span>
          <span className="config-block-hint">给 QQ 等外部身份设档位或细调；deny &gt; owner(*) &gt; public &gt; grant。仅 owner 可改。</span>
          <span className={`config-block-toggle ${openSections.has('users') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('users') && (
          <div className="config-block-body">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <input
                className="config-edit-input"
                style={{ maxWidth: 160 }}
                placeholder="平台 (如 onebot)"
                list="authority-platforms"
                value={newUser.platform}
                onChange={e => setNewUser(v => ({ ...v, platform: e.target.value }))}
              />
              <input
                className="config-edit-input"
                style={{ maxWidth: 160 }}
                placeholder="用户 ID"
                value={newUser.userId}
                onChange={e => setNewUser(v => ({ ...v, userId: e.target.value }))}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!newUser.platform || !newUser.userId}
                onClick={() => {
                  const u = { platform: newUser.platform, userId: newUser.userId };
                  setNewUser({ platform: '', userId: '' });
                  setEditUser(`${u.platform}:${u.userId}`);
                  // 仅打开编辑器；空记录在保存非空 caps 时才落库
                  if (!data.users.some(x => x.platform === u.platform && x.userId === u.userId)) {
                    setData(d => (d ? { ...d, users: [...d.users, { ...u, isOwner: false }] } : d));
                  }
                }}
              >
                + 添加身份
              </button>
              <button type="button" className="btn btn-sm" onClick={refresh} disabled={loading}>
                刷新
              </button>
            </div>
            {users.length === 0 ? (
              <div className="empty-hint">暂无用户记录。public 操作对所有人默认开放，无需登记。</div>
            ) : (
              users.map(u => {
                const key = `${u.platform}:${u.userId}`;
                const preset = detectPreset(u.grant, u.deny);
                const isEditing = editUser === key;
                return (
                  <div key={key} className="authority-cmd-list" style={{ marginBottom: 6 }}>
                    <div className="authority-cmd-row authority-user-row">
                      <span className="authority-cell-id" style={{ flex: 1 }}>
                        <strong>{u.platform}</strong>:{u.userId}
                        <span className="authority-user-flag" title={`授予: ${(u.grant ?? []).join(', ') || '无'}\n拒绝: ${(u.deny ?? []).join(', ') || '无'}`}>
                          {PRESET_LABEL[preset]}
                          {preset === 'custom' ? ` +${u.grant?.length ?? 0}/−${u.deny?.length ?? 0}` : ''}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <SegButtons<Preset>
                          value={preset}
                          options={[
                            { v: 'banned', label: '封禁' },
                            { v: 'normal', label: '普通' },
                            { v: 'trusted', label: '信任' },
                            { v: 'custom', label: '自定义' },
                          ]}
                          onPick={p => (p === 'custom' ? setEditUser(isEditing ? null : key) : applyPreset(u, p))}
                        />
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => act('deleteUser', { platform: u.platform, userId: u.userId }, '已删除')}>
                          删除
                        </button>
                      </span>
                    </div>
                    {isEditing && (
                      <UserCapEditor
                        key={`edit:${key}`}
                        ops={ops}
                        initialGrant={u.grant ?? []}
                        initialDeny={u.deny ?? []}
                        onSave={(g, d) => saveUserCaps(u, g, d)}
                        onCancel={() => setEditUser(null)}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ═══ Owner ═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('owners')}>
          <span className="config-block-title">Owner</span>
          <span className="config-block-hint">Owner 拥有全部能力（*）；console（本机登录）恒为 Owner。</span>
          <span className={`config-block-toggle ${openSections.has('owners') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('owners') && (
          <div className="config-block-body">
            <button type="button" className="btn btn-sm" onClick={() => setShowAddOwner(s => !s)}>
              {showAddOwner ? '取消' : '+ 添加 Owner'}
            </button>
            {showAddOwner && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="config-edit-input" style={{ maxWidth: 160 }} placeholder="平台" list="authority-platforms" value={newOwner.platform} onChange={e => setNewOwner(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" style={{ maxWidth: 160 }} placeholder="用户 ID" value={newOwner.userId} onChange={e => setNewOwner(v => ({ ...v, userId: e.target.value }))} />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!newOwner.platform || !newOwner.userId}
                  onClick={() => {
                    act('setOwners', { owners: [...data.owners, { ...newOwner }] }, 'Owner 已添加');
                    setNewOwner({ platform: '', userId: '' });
                    setShowAddOwner(false);
                  }}
                >
                  确认
                </button>
              </div>
            )}
            {data.owners.length === 0 ? (
              <div className="empty-hint" style={{ marginTop: 8 }}>暂无显式 Owner。console 始终拥有全部能力。</div>
            ) : (
              <div className="authority-cmd-list" style={{ marginTop: 8 }}>
                {data.owners.map((o, i) => (
                  <div className="authority-cmd-row" key={`${o.platform}:${o.userId}`}>
                    <span style={{ flex: 1 }}>
                      <strong>{o.platform}</strong>:{o.userId}
                    </span>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => act('setOwners', { owners: data.owners.filter((_, j) => j !== i) }, 'Owner 已移除')}>
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ 高级 ═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('adv')}>
          <span className="config-block-title">
            <SlidersHorizontal size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            高级
          </span>
          <span className="config-block-hint">全局硬禁能力 + 受限能力的临时自动放行（给自动化）+ 当前临时放行。</span>
          <span className={`config-block-toggle ${openSections.has('adv') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('adv') && (
          <div className="config-block-body">
            {editAdv ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">硬禁(denied)</label>
                  <input className="config-edit-input" value={advDraft.denied} onChange={e => setAdvDraft(v => ({ ...v, denied: e.target.value }))} placeholder="tool:dangerous.*" />
                  <span className="config-edit-hint">连 owner 都压过，慎用</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">自动放行(allow)</label>
                  <input className="config-edit-input" value={advDraft.allow} onChange={e => setAdvDraft(v => ({ ...v, allow: e.target.value }))} placeholder="tool:file.* 或 *" />
                  <span className="config-edit-hint">受限能力免确认自动放行（自动化用）</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">时长(秒)</label>
                  <input type="number" className="config-edit-input" min={0} value={advDraft.duration} onChange={e => setAdvDraft(v => ({ ...v, duration: parseInt(e.target.value, 10) || 0 }))} />
                  <span className="config-edit-hint">0 = 永久</span>
                </div>
                <div className="config-edit-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      await act('setConfig', { deniedCapabilities: toList(advDraft.denied) });
                      await act('setRestrictedPolicy', { policy: { allow: toList(advDraft.allow), duration: advDraft.duration } }, '高级配置已保存');
                      setEditAdv(false);
                    }}
                  >
                    保存
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditAdv(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">硬禁能力</span>
                  <span className="val">{(data.deniedCapabilities ?? []).join(', ') || '(无)'}</span>
                </div>
                <div className="config-item">
                  <span className="key">自动放行</span>
                  <span className="val">
                    {(data.restrictedPolicy?.allow ?? []).join(', ') || '(无)'}
                    {data.restrictedPolicy?.allow?.length ? ` · ${data.restrictedPolicy?.duration ? `${data.restrictedPolicy.duration}s` : '永久'}` : ''}
                  </span>
                </div>
                <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setEditAdv(true)}>
                  编辑
                </button>
              </>
            )}
            <div className="section-label" style={{ marginTop: 12 }}>当前临时放行</div>
            {data.temporaryGrants.length === 0 ? (
              <div className="empty-hint" style={{ padding: '4px 0' }}>暂无。</div>
            ) : (
              <div className="authority-cmd-list">
                {data.temporaryGrants.map(g => (
                  <div className="authority-cmd-row" key={g.id}>
                    <span className="authority-cmd-name" title={g.sessionId}>
                      {g.capability}
                      <span className="authority-cmd-plugin" style={{ marginLeft: 6 }}>{g.sessionId}</span>
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.8, marginRight: 8 }}>{g.used}{g.maxUses ? ` / ${g.maxUses}` : ''}</span>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => act('revokeTemporaryGrant', { id: g.id }, '已撤销')}>
                      撤销
                    </button>
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
