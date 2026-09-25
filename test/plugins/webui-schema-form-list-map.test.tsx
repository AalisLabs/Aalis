// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDraftFromSchema, SchemaForm } from '../../packages/plugin-webui-client/src/components/SchemaForm.js';
import type { ConfigSchema } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// SchemaForm 的 list / map 字段：多行文本编辑，提交的是数组 / 映射。
// 没有这两种渲染时字段退回字符串输入框：数组显示成 '-y,a b'，一编辑就把参数写成一整串。
// ════════════════════════════════════════════════════════════

afterEach(cleanup);

const schema: ConfigSchema = {
  args: { type: 'list', label: '参数' },
  env: { type: 'map', label: '环境变量' },
};

function renderForm(initial: Record<string, unknown>) {
  const drafts: Array<Record<string, unknown>> = [];
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return (
      <SchemaForm
        schema={schema}
        draft={draft}
        onChange={d => {
          drafts.push(d);
          setDraft(d);
        }}
        modelCache={{}}
        onFetchModels={() => {}}
        onFetchLLMProviders={() => {}}
      />
    );
  }
  const { container } = render(<Harness />);
  const [args, env] = [...container.querySelectorAll('textarea')];
  return { args, env, last: () => drafts[drafts.length - 1] };
}

describe('SchemaForm list 字段', () => {
  it('数组逐行显示；编辑后仍是数组，保序、保留空格与重复项', () => {
    const f = renderForm({ args: ['-y', 'a b'], env: {} });
    expect(f.args.value).toBe('-y\na b');
    fireEvent.change(f.args, { target: { value: '-y\na b\n-e\nX\n-e\nX' } });
    expect(f.last().args).toEqual(['-y', 'a b', '-e', 'X', '-e', 'X']);
  });

  it('回车产生的空行留在输入框里，不进提交值', () => {
    const f = renderForm({ args: ['-y'], env: {} });
    fireEvent.change(f.args, { target: { value: '-y\n' } });
    expect(f.args.value, '空行被解析后再格式化回去，换行就被吃掉了').toBe('-y\n');
    expect(f.last().args).toEqual(['-y']);
  });
});

describe('SchemaForm map 字段', () => {
  it('映射显示为 KEY=VALUE；按第一个 = 切分，值原样，缺 = 的行不提交', () => {
    const f = renderForm({ args: [], env: { TOKEN: 'x y' } });
    expect(f.env.value).toBe('TOKEN=x y');
    fireEvent.change(f.env, { target: { value: 'TOKEN=x y\n URL =a=b\nNOEQ\n=v' } });
    expect(f.last().env).toEqual({ TOKEN: 'x y', URL: 'a=b' });
  });
});

describe('初值', () => {
  it('未配置且无 default 的 list / map 草稿初值为 [] / {}', () => {
    expect(buildDraftFromSchema(schema, {})).toEqual({ args: [], env: {} });
  });

  it('旧版存下的空串按 [] / {} 进草稿（顶层、分组、数组条目），原样保存即写回合法形态；非空字符串原样保留', () => {
    const legacySchema: ConfigSchema = {
      ...schema,
      group: {
        label: '分组',
        fields: { args: { type: 'list', label: '参数' }, env: { type: 'map', label: '环境变量' } },
      },
      servers: {
        type: 'array',
        label: '服务器',
        items: {
          id: { type: 'string', label: 'ID' },
          args: { type: 'list', label: '参数' },
          env: { type: 'map', label: '环境变量' },
        },
      },
    };
    const draft = buildDraftFromSchema(legacySchema, {
      args: '',
      env: '',
      group: { args: '', env: '' },
      servers: [
        { id: 'gh', args: '', env: '' },
        { id: 'old', args: '-y @scope/pkg', env: 'TOKEN=x' },
      ],
    });
    expect(draft).toEqual({
      args: [],
      env: {},
      group: { args: [], env: {} },
      servers: [
        { id: 'gh', args: [], env: {} },
        { id: 'old', args: '-y @scope/pkg', env: 'TOKEN=x' },
      ],
    });
  });

  it('数组条目「+ 添加」时，必填且无 default 的 list / map 初值为 [] / {}', () => {
    const arraySchema: ConfigSchema = {
      servers: {
        type: 'array',
        label: '服务器',
        items: {
          args: { type: 'list', label: '参数', required: true },
          env: { type: 'map', label: '环境变量', required: true },
        },
      },
    };
    const drafts: Array<Record<string, unknown>> = [];
    const { getByText } = render(
      <SchemaForm
        schema={arraySchema}
        draft={{ servers: [] }}
        onChange={d => drafts.push(d)}
        modelCache={{}}
        onFetchModels={() => {}}
        onFetchLLMProviders={() => {}}
      />,
    );
    fireEvent.click(getByText('+ 添加'));
    expect(drafts[drafts.length - 1]).toEqual({ servers: [{ args: [], env: {} }] });
  });
});

describe('逐行文本表达不了的值', () => {
  it('map 值含换行：只读展示并提示去配置文件改，不提供逐行编辑', () => {
    const pem = '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END KEY-----';
    const f = renderForm({ args: ['-y'], env: { TOKEN: 'abc', PRIVATE_KEY: pem } });
    expect(f.env.readOnly, '逐行重解析会截断多行值、把续行变成新键').toBe(true);
    expect(JSON.parse(f.env.value)).toEqual({ TOKEN: 'abc', PRIVATE_KEY: pem });
    expect(f.env.parentElement?.textContent).toContain('请在配置文件中修改');
    fireEvent.change(f.env, { target: { value: 'TOKEN=abc\nNEW=1' } });
    expect(f.last(), '只读字段不产生草稿变更').toBeUndefined();
    expect(f.args.readOnly, '同表单里可逐行表达的字段照常可编辑').toBe(false);
  });

  it('list 含空白项或含换行的项：只读展示', () => {
    for (const args of [
      ['--flag', '', '--name', 'a b'],
      ['--flag', 'x\ny'],
    ]) {
      const f = renderForm({ args, env: {} });
      expect(f.args.readOnly, JSON.stringify(args)).toBe(true);
      expect(JSON.parse(f.args.value)).toEqual(args);
      cleanup();
    }
  });

  it('数字、布尔项或值照常逐行编辑，编辑后规整为字符串', () => {
    const f = renderForm({ args: ['--port', 3000, true], env: { PORT: 8080, DEBUG: false } });
    expect(f.args.readOnly, 'YAML 里自然写出的 3000 / true 不该让整个字段只读').toBe(false);
    expect(f.env.readOnly).toBe(false);
    expect(f.args.value).toBe('--port\n3000\ntrue');
    expect(f.env.value).toBe('PORT=8080\nDEBUG=false');
    fireEvent.change(f.args, { target: { value: '--port\n3001\ntrue' } });
    expect(f.last().args).toEqual(['--port', '3001', 'true']);
    fireEvent.change(f.env, { target: { value: 'PORT=8080\nDEBUG=false\nMODE=dev' } });
    expect(f.last().env).toEqual({ PORT: '8080', DEBUG: 'false', MODE: 'dev' });
  });

  it('null、嵌套的数组或对象仍只读，提示点明非标量', () => {
    const cases: Array<[Record<string, unknown>, 'args' | 'env']> = [
      [{ args: ['-y', null], env: {} }, 'args'],
      [{ args: ['-y', ['a']], env: {} }, 'args'],
      [{ args: [], env: { A: null } }, 'env'],
      [{ args: [], env: { A: { b: 1 } } }, 'env'],
    ];
    for (const [initial, key] of cases) {
      const field = renderForm(initial)[key];
      expect(field.readOnly, JSON.stringify(initial)).toBe(true);
      expect(field.parentElement?.textContent).toContain('非标量');
      cleanup();
    }
  });
});

describe('外部值变化', () => {
  it('草稿被整体替换（恢复默认 / 重新加载）时输入框跟着更新', () => {
    const props = { modelCache: {}, onFetchModels: () => {}, onFetchLLMProviders: () => {}, onChange: () => {} };
    const { container, rerender } = render(
      <SchemaForm schema={schema} draft={{ args: ['a'], env: { K: 'v' } }} {...props} />,
    );
    rerender(<SchemaForm schema={schema} draft={{ args: [], env: {} }} {...props} />);
    const [args, env] = [...container.querySelectorAll('textarea')];
    expect(args.value).toBe('');
    expect(env.value).toBe('');
  });
});
