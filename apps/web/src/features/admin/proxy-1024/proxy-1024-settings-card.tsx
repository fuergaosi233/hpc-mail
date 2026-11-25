import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, IntField, MoneyField, NativeSelect, Panel, SecretField, ToggleField, useVendorSettings } from '../shared/vendor-ui';

/** settings.proxy1024：只 PUT 这一个 key；密码与会话令牌回显掩码 */
export function Proxy1024SettingsCard() {
  const queryClient = useQueryClient();
  const { query, saved, draft, patch, save, dirty, reset } = useVendorSettings('proxy1024', () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxy1024Status });
  });

  if (query.isPending) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!draft) return null;

  return (
    <Panel
      title="配置"
      description="1024proxy 没有公开下单 API，这里保存控制台登录信息并自动化其网页接口。单笔与每日上限为 0 时禁止采购。"
    >
      <ToggleField
        label="启用 1024 采购"
        description="关闭时不调用 1024 任何接口，定时对账也会跳过。"
        checked={draft.enabled}
        onChange={(value) => patch((s) => void (s.enabled = value))}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="登录邮箱">
          {(id) => (
            <Input id={id} value={draft.email} maxLength={254} autoComplete="off" onChange={(e) => patch((s) => void (s.email = e.target.value.trim()))} />
          )}
        </Field>
        <SecretField
          label="登录密码"
          hint="用于「登录 1024」（需人工拖动滑块验证）"
          value={draft.password}
          saved={saved?.password}
          onChange={(value) => patch((s) => void (s.password = value))}
        />
        <SecretField
          label="会话令牌（zero_sid）"
          hint="也可以直接粘贴浏览器里 1024 控制台的 zero_sid Cookie"
          value={draft.sessionToken}
          saved={saved?.sessionToken}
          onChange={(value) => patch((s) => void (s.sessionToken = value))}
        />
        <Field label="接口语言">
          {(id) => (
            <NativeSelect id={id} value={draft.lang} onChange={(e) => patch((s) => void (s.lang = e.target.value as 'en' | 'zh'))}>
              <option value="en">English</option>
              <option value="zh">中文</option>
            </NativeSelect>
          )}
        </Field>
        <MoneyField
          label="单笔上限"
          hint="按未折扣价比较；0 = 禁止采购"
          cents={draft.maxOrderCents}
          maxCents={10_000_00}
          onChange={(value) => patch((s) => void (s.maxOrderCents = value))}
        />
        <MoneyField
          label="24 小时滚动上限"
          hint="按本站订单台账统计；0 = 禁止采购"
          cents={draft.maxDailyCents}
          maxCents={100_000_00}
          onChange={(value) => patch((s) => void (s.maxDailyCents = value))}
        />
        <IntField
          label="报价有效期（分钟）"
          value={draft.quoteTtlMinutes}
          min={1}
          max={60}
          onChange={(value) => patch((s) => void (s.quoteTtlMinutes = value))}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={!dirty || save.isPending} onClick={reset}>
          撤销
        </Button>
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
          保存配置
        </Button>
      </div>
    </Panel>
  );
}
