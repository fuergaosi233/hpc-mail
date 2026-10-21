import type { HostedDomainRole, HostedDomainStatus, HostedDomainSteps } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';

interface StatusMeta {
  label: string;
  tone: BadgeTone;
  /** 详情页顶部的一句话说明 */
  description: string;
  /** 成员看不到名称服务器指引，需要所有者处理的状态单独说明 */
  memberDescription?: string;
}

export const HOSTED_DOMAIN_STATUS_META: Record<HostedDomainStatus, StatusMeta> = {
  pending: {
    label: '等待修改 NS',
    tone: 'caution',
    description: '已分配名称服务器，请到域名注册商把 NS 改为下方两条，系统检测到生效后会自动开通收发。',
    memberDescription: '等待所有者到注册商修改名称服务器，生效后即可在该域名下认领地址。',
  },
  provisioning: {
    label: '开通中',
    tone: 'accent',
    description: '名称服务器已生效，正在开通收件路由与发信，通常几分钟内完成。',
  },
  active: {
    label: '已生效',
    tone: 'positive',
    description: '收件和发信均已就绪，可以在该域名下认领地址收发邮件。',
  },
  error: {
    label: '开通异常',
    tone: 'critical',
    description: '名称服务器已生效，但开通或巡检没有通过，系统会定时重试。',
  },
  moved: {
    label: 'NS 已改走',
    tone: 'critical',
    description: '域名的名称服务器已不再指向本站（可能改回了原服务商或域名已过期），收发已停止。',
    memberDescription: '域名的名称服务器已不再指向本站，收发已停止，请联系所有者处理。',
  },
  suspended: {
    label: '已暂停',
    tone: 'neutral',
    description: '管理员已暂停该域名：拒收来信，禁止发信和新认领。',
  },
  deleting: {
    label: '删除中',
    tone: 'neutral',
    description: '正在清理该域名下的地址、邮件与 Cloudflare 配置，完成后域名会从列表中消失。',
  },
};

export const HOSTED_DOMAIN_STATUS_OPTIONS = Object.entries(HOSTED_DOMAIN_STATUS_META).map(([value, meta]) => ({
  value: value as HostedDomainStatus,
  label: meta.label,
}));

export function HostedDomainStatusBadge({ status }: { status: HostedDomainStatus }) {
  const meta = HOSTED_DOMAIN_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

const ROLE_LABELS: Record<HostedDomainRole, string> = {
  owner: '我的',
  member: '共享给我',
  admin: '管理员查看',
};

export function HostedDomainRoleBadge({ role }: { role: HostedDomainRole }) {
  return <Badge tone={role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABELS[role]}</Badge>;
}

/** 开通环节按生效顺序排列 */
export const HOSTED_DOMAIN_STEPS: ReadonlyArray<{ key: keyof HostedDomainSteps; label: string; description: string }> = [
  { key: 'nameServers', label: '名称服务器已生效', description: '域名的 NS 已指向本站分配的名称服务器' },
  { key: 'routing', label: '收件路由', description: '收件所需的 MX、SPF、DKIM 记录' },
  { key: 'catchAll', label: '全部地址投递到本站', description: '任意前缀的来信都交给本站处理' },
  { key: 'sending', label: '发信', description: '发信所需的退信域与 DKIM、DMARC 记录' },
];
