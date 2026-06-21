import { Clock, Crown, SlidersHorizontal, User, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { pageAction } from '../api';
import {
  type ConfirmOverride,
  type Operation,
  capKey,
  derivedMinLevel,
  effectiveConfirm,
  effectiveMinLevel,
  groupByPlugin,
  groupMinLevel,
} from './authority-page-util.js';

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
  level: number;
  note?: string;
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
  authorityOverrides: Record<string, number>;
  defaultAuthority: number;
  confirmOverrides: Record<string, ConfirmOverride>;
  autoConfirmUntil: number;
  restrictedPolicy: { allow?: string[]; duration?: number };
  temporaryGrants: TemporaryGrant[];
  commandPrefix: string;
  commands: Operation[];
  tools: Operation[];
}

/** 多态按钮组（当前值高亮）。所有按钮都有 onClick，绝不空转。 */
function SegButtons({
  value,
  options,
  onPick,
}: {
  value: string;
  options: Array<{ v: string; label: string }>;
  onPick: (v: string) => void;
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

/**
 * 整数等级输入框（提交在失焦 / 回车，避免逐字符触发）。当前值始终可见。
 * value='' 表示「未设/默认」；onCommit(null) 表示清除（回退默认），onCommit(n) 写入整数。
 */
function LevelInput({
  value,
  onCommit,
  placeholder,
  title,
}: {
  value: number | '';
  onCommit: (n: number | null) => void;
  placeholder?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(value === '' ? '' : String(value));
  useEffect(() => {
    setDraft(value === '' ? '' : String(value));
  }, [value]);
  const commit = () => {
    const t = draft.trim();
    if (t === '') {
      onCommit(null);
      return;
    }
    const n = Number.parseInt(t, 10);
    if (Number.isInteger(n)) onCommit(n);
    else setDraft(value === '' ? '' : String(value)); // 非法输入回滚
  };
  return (
    <input
      type="number"
      step={1}
      className="config-edit-input authority-level-input"
      style={{ width: 68, textAlign: 'center' }}
      value={draft}
      placeholder={placeholder}
      title={title}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
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

  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['users', 'ops']));
  const toggleSection = (k: string) =>
    setOpenSections(prev => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const [opQuery, setOpQuery] = useState('');
  const [opType, setOpType] = useState<'all' | 'command' | 'tool'>('all');
  const [openPlugins, setOpenPlugins] = useState<Set<string>>(new Set());
  const [newUser, setNewUser] = useState({ platform: '', userId: '', level: '1' });
  const [newOwner, setNewOwner] = useState({ platform: '', userId: '' });
  const [showAddOwner, setShowAddOwner] = useState(false);
  const [advDraft, setAdvDraft] = useState({ denied: '', allow: '', duration: 0 });
  const [showManual, setShowManual] = useState(false);

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
  const opGroups = groupByPlugin(ops.filter(op => opType === 'all' || op.type === opType));
  const ql = opQuery.trim().toLowerCase();
  const users = data.users.filter(u => !u.isOwner);
  const denied = data.deniedCapabilities ?? [];
  const allow = data.restrictedPolicy?.allow ?? [];
  const acUntil = data.autoConfirmUntil ?? 0;
  const acActive = acUntil === -1 || acUntil > Date.now();
  const acStatus = acUntil === -1 ? '一直开启' : acUntil > Date.now() ? `开启中 · 剩 ${Math.ceil((acUntil - Date.now()) / 60000)} 分钟` : '关闭';

  const setUserLevel = (u: { platform: string; userId: string }, level: number) =>
    act('setUserLevel', { platform: u.platform, userId: u.userId, level }, `已设等级: ${level}`);
  const setOpLevel = (op: Operation, level: number | null) =>
    act('setAuthorityOverride', { name: capKey(op), level }, '已更新最低等级');
  const setOpConfirm = (op: Operation, c: ConfirmOverride | '') => act('setConfirmOverride', { name: capKey(op), confirm: c }, '已更新确认');
  const setGroupLevel = async (groupOps: Operation[], level: number) => {
    try {
      await Promise.all(groupOps.map(op => pageAction(PLUGIN, 'setAuthorityOverride', { name: capKey(op), level })));
      flash('整组最低等级已更新');
      await refresh();
    } catch (e) {
      flash(errMsg(e));
    }
  };
  const applyDenied = (list: string[]) => act('setConfig', { deniedCapabilities: list }, '已更新硬禁');
  const applyAllow = (list: string[], duration: number) =>
    act('setRestrictedPolicy', { policy: { allow: list, duration } }, '已更新自动放行');

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
          <div className="overview-card-icon"><User size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">用户</div>
            <div className="overview-card-value">{users.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Wrench size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">操作</div>
            <div className="overview-card-value">{ops.length}</div>
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

      {/* ═══ 确认模式（auto：owner 临时免 dangerous 二次确认，批处理用）═══ */}
      <div className="config-block" style={acActive ? { borderColor: '#f59e0b' } : undefined}>
        <div className="config-block-header" style={{ cursor: 'default' }}>
          <span className="config-block-title">
            确认模式
            {acActive && <span style={{ marginLeft: 8, color: '#f59e0b', fontSize: 12 }}>⚠ 自动确认中</span>}
          </span>
          <span className="config-block-hint">
            开启后 owner 本人执行 dangerous 操作免二次确认（批处理便利）。等级门禁 / 封禁 / always 确认仍生效。当前：{acStatus}
          </span>
        </div>
        <div className="config-block-body">
          <span style={{ opacity: 0.6, fontSize: 12, marginRight: 8 }}>设为</span>
          <SegButtons
            value={acUntil === -1 ? '-1' : acUntil > Date.now() ? '' : '0'}
            options={[
              { v: '0', label: '关' },
              { v: '30', label: '30 分钟' },
              { v: '60', label: '1 小时' },
              { v: '-1', label: '一直' },
            ]}
            onPick={v => act('setAutoConfirm', { minutes: Number(v) }, '已更新确认模式')}
          />
        </div>
      </div>

      {/* ═══ 用户（设数字等级，好管主场）═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('users')}>
          <span className="config-block-title">用户（外部身份的权限等级）</span>
          <span className="config-block-hint">
            给 QQ 等外部身份设一个整数等级：越大权限越高 · 默认 {data.defaultAuthority} · 封禁=负数 · owner=∞。仅 owner 可改。
          </span>
          <span className={`config-block-toggle ${openSections.has('users') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('users') && (
          <div className="config-block-body">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
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
              <span style={{ opacity: 0.6, fontSize: 12 }}>等级</span>
              <input
                type="number"
                step={1}
                className="config-edit-input"
                style={{ width: 72, textAlign: 'center' }}
                value={newUser.level}
                onChange={e => setNewUser(v => ({ ...v, level: e.target.value }))}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!newUser.platform || !newUser.userId}
                onClick={() => {
                  const lv = Number.parseInt(newUser.level, 10);
                  if (!Number.isInteger(lv)) {
                    flash('等级必须是整数');
                    return;
                  }
                  const u = { platform: newUser.platform, userId: newUser.userId };
                  setNewUser({ platform: '', userId: '', level: '1' });
                  setUserLevel(u, lv);
                }}
              >
                + 添加身份
              </button>
              <button type="button" className="btn btn-sm" onClick={refresh} disabled={loading}>
                刷新
              </button>
            </div>
            {users.length === 0 ? (
              <div className="empty-hint">
                暂无登记用户。默认等级（{data.defaultAuthority}）对所有人开放，无需登记；需要放权/封禁时在此添加。
              </div>
            ) : (
              users.map(u => (
                <div key={`${u.platform}:${u.userId}`} className="authority-cmd-row authority-user-row">
                  <span className="authority-cell-id" style={{ flex: 1 }}>
                    <strong>{u.platform}</strong>:{u.userId}
                    {u.note ? <span className="authority-user-flag">{u.note}</span> : null}
                  </span>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ opacity: 0.6, fontSize: 12 }}>等级</span>
                    <LevelInput value={u.level} onCommit={n => setUserLevel(u, n ?? data.defaultAuthority)} title="整数；越大越高，负数=封禁" />
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => act('deleteUser', { platform: u.platform, userId: u.userId }, '已删除')}>
                      删除
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ═══ 操作（最低等级 + 确认，默认来自风险，偶尔覆盖）═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('ops')}>
          <span className="config-block-title">操作（指令 / 工具的门槛）</span>
          <span className="config-block-hint">
            每个操作一个「最低等级」（默认按风险派生 safe0/sensitive1/dangerous2）+ 确认要求。owner 可逐条/整组覆盖成任意整数；多数无需动。
          </span>
          <span className={`config-block-toggle ${openSections.has('ops') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('ops') && (
          <div className="config-block-body">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <input
                className="config-edit-input"
                style={{ flex: 1, minWidth: 180 }}
                placeholder="搜索插件 / 操作…"
                value={opQuery}
                onChange={e => setOpQuery(e.target.value)}
              />
              <SegButtons
                value={opType}
                options={[
                  { v: 'all', label: '全部' },
                  { v: 'command', label: '指令' },
                  { v: 'tool', label: '工具' },
                ]}
                onPick={v => setOpType(v as 'all' | 'command' | 'tool')}
              />
            </div>
            {opGroups.map(({ plugin, ops: groupOps }) => {
              const shown = groupOps.filter(op => !ql || op.pluginName.toLowerCase().includes(ql) || op.displayName.toLowerCase().includes(ql));
              if (shown.length === 0) return null;
              const isOpen = openPlugins.has(plugin) || ql.length > 0;
              const needConfirm = shown.filter(op => effectiveConfirm(op, data.confirmOverrides)).length;
              return (
                <div key={plugin} className="plugin-card" style={{ marginTop: 8 }}>
                  <div className="plugin-card-header">
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 'none' }}
                      onClick={() =>
                        setOpenPlugins(prev => {
                          const n = new Set(prev);
                          n.has(plugin) ? n.delete(plugin) : n.add(plugin);
                          return n;
                        })
                      }
                    >
                      <span style={{ marginRight: 6, opacity: 0.55 }}>{isOpen ? '▾' : '▸'}</span>
                      <strong>{plugin}</strong> <span style={{ opacity: 0.5 }}>({shown.length})</span>
                      {needConfirm > 0 && (
                        <span
                          style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 6, background: 'rgba(245,158,11,0.16)', color: '#f59e0b' }}
                          title={`本组有 ${needConfirm} 个操作需确认（危险）`}
                        >
                          ⚠ {needConfirm} 需确认
                        </span>
                      )}
                    </button>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ opacity: 0.55, fontSize: 11 }}>批量设为</span>
                      <LevelInput
                        value=""
                        placeholder="等级"
                        title="批量设置本组所有操作的最低等级"
                        onCommit={n => n !== null && setGroupLevel(shown, n)}
                      />
                    </span>
                  </div>
                  {isOpen && (
                    <div style={{ borderTop: '1px solid var(--border)' }}>
                      {shown.map(op => {
                        const k = capKey(op);
                        const conf = effectiveConfirm(op, data.confirmOverrides);
                        const overridden = k in data.authorityOverrides;
                        const derived = derivedMinLevel(op);
                        const eff = effectiveMinLevel(op, data.authorityOverrides);
                        const confOv = data.confirmOverrides[k];
                        const isCmd = op.type === 'command';
                        return (
                          <div
                            key={k}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '7px 12px',
                              borderTop: '1px solid var(--border)',
                            }}
                          >
                            <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: 6,
                                  whiteSpace: 'nowrap',
                                  background: isCmd ? 'rgba(91,141,239,0.16)' : 'rgba(45,191,128,0.16)',
                                  color: isCmd ? '#5b8def' : '#2dbf80',
                                }}
                              >
                                {isCmd ? '指令' : '工具'}
                              </span>
                              <span className="authority-cmd-name" title={k}>{op.displayName}</span>
                              {overridden && <span style={{ color: '#f59e0b' }} title={`已覆盖（默认 ${derived}）`}>●</span>}
                            </span>
                            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                              <span style={{ opacity: 0.6, fontSize: 11 }}>等级</span>
                              <LevelInput
                                value={overridden ? eff : ''}
                                placeholder={`默认${derived}`}
                                title={`留空=默认(${derived})；填整数=覆盖`}
                                onCommit={n => setOpLevel(op, n)}
                              />
                              <span style={{ opacity: 0.4 }}>|</span>
                              <span style={{ opacity: 0.6, fontSize: 11 }} title="确认=危险：会话/每次=执行前要人点头；关=不弹">
                                确认
                              </span>
                              <SegButtons
                                value={confOv ?? 'default'}
                                options={[
                                  { v: 'default', label: conf ? `默认(${conf === 'always' ? '每次' : '会话'})` : '默认' },
                                  { v: 'off', label: '关' },
                                  { v: 'session', label: '会话' },
                                  { v: 'always', label: '每次' },
                                ]}
                                onPick={c => setOpConfirm(op, c === 'default' ? '' : (c as ConfirmOverride))}
                              />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══ Owner ═══ */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('owners')}>
          <span className="config-block-title">Owner</span>
          <span className="config-block-hint">Owner 拥有全部权限；console（本机登录）恒为 Owner。</span>
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
              <div className="empty-hint" style={{ marginTop: 8 }}>暂无显式 Owner。console 始终拥有全部权限。</div>
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
          <span className="config-block-hint">全局硬禁（连 owner 都拒）+ 受限操作自动放行（给自动化）+ 当前临时放行。直接选操作即可，无需手写。</span>
          <span className={`config-block-toggle ${openSections.has('adv') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('adv') && (
          <div className="config-block-body">
            {/* 硬禁操作：选操作加 chip，无需手写 */}
            <div className="section-label" style={{ marginTop: 0 }}>硬禁操作（连 owner 都拒，慎用）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              {denied.length === 0 ? (
                <span className="empty-hint" style={{ padding: 0 }}>无</span>
              ) : (
                denied.map(cap => (
                  <span key={cap} className="tool-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {cap}
                    <button type="button" className="btn btn-sm" style={{ padding: '0 5px', lineHeight: 1 }} title="移除" onClick={() => applyDenied(denied.filter(x => x !== cap))}>
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <select
              className="config-edit-input"
              style={{ maxWidth: 340 }}
              value=""
              onChange={e => {
                const v = e.target.value;
                if (v && !denied.includes(v)) applyDenied([...denied, v]);
              }}
            >
              <option value="">+ 选要硬禁的操作…</option>
              {ops.map(op => (
                <option key={capKey(op)} value={capKey(op)}>
                  {op.type === 'command' ? '指令 ' : '工具 '}
                  {op.displayName}
                </option>
              ))}
            </select>

            {/* 自动放行：同样选操作 */}
            <div className="section-label">自动放行（受限操作免确认，给自动化）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              {allow.length === 0 ? (
                <span className="empty-hint" style={{ padding: 0 }}>无</span>
              ) : (
                allow.map(cap => (
                  <span key={cap} className="tool-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {cap}
                    <button type="button" className="btn btn-sm" style={{ padding: '0 5px', lineHeight: 1 }} title="移除" onClick={() => applyAllow(allow.filter(x => x !== cap), advDraft.duration)}>
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="config-edit-input"
                style={{ maxWidth: 340 }}
                value=""
                onChange={e => {
                  const v = e.target.value;
                  if (v && !allow.includes(v)) applyAllow([...allow, v], advDraft.duration);
                }}
              >
                <option value="">+ 选要自动放行的操作…</option>
                {ops.map(op => (
                  <option key={capKey(op)} value={capKey(op)}>
                    {op.type === 'command' ? '令 ' : '具 '}
                    {op.displayName}
                  </option>
                ))}
              </select>
              <span style={{ opacity: 0.6, fontSize: 11 }}>时长(秒,0=永久)</span>
              <input
                type="number"
                min={0}
                className="config-edit-input"
                style={{ width: 90 }}
                value={advDraft.duration}
                onChange={e => setAdvDraft(v => ({ ...v, duration: parseInt(e.target.value, 10) || 0 }))}
                onBlur={() => applyAllow(allow, advDraft.duration)}
              />
            </div>

            {/* 手填 glob：高级逃生口（picker 只能选具体操作，glob 如 tool:* / * 仍可手填） */}
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setShowManual(s => !s)}>
              {showManual ? '收起手填' : '手填 glob（高级，如 tool:* / *）'}
            </button>
            {showManual && (
              <div className="config-edit-form" style={{ marginTop: 6 }}>
                <div className="config-edit-row">
                  <label className="config-edit-label">硬禁(glob)</label>
                  <input className="config-edit-input" value={advDraft.denied} onChange={e => setAdvDraft(v => ({ ...v, denied: e.target.value }))} placeholder="tool:dangerous.*" />
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">放行(glob)</label>
                  <input className="config-edit-input" value={advDraft.allow} onChange={e => setAdvDraft(v => ({ ...v, allow: e.target.value }))} placeholder="tool:file.* 或 *" />
                </div>
                <div className="config-edit-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      if (advDraft.denied.trim()) await act('setConfig', { deniedCapabilities: [...new Set([...denied, ...toList(advDraft.denied)])] });
                      if (advDraft.allow.trim())
                        await act('setRestrictedPolicy', { policy: { allow: [...new Set([...allow, ...toList(advDraft.allow)])], duration: advDraft.duration } }, '已追加');
                      setAdvDraft(v => ({ ...v, denied: '', allow: '' }));
                      setShowManual(false);
                    }}
                  >
                    追加
                  </button>
                </div>
              </div>
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
