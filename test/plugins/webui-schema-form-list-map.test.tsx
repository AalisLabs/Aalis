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
