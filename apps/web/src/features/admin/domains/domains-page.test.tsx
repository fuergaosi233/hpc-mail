import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(async (patch) => ({ domains: patch.domains })), toast: vi.fn(), stats: vi.fn(async () => [] as unknown[]) }));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.get, updateSettings: mocks.update, domainStatus: vi.fn(async () => ({resolved:false})), domainClaudeStats: mocks.stats } }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({useMailboxesQuery: () => ({data: []})}));
vi.mock('@/components/ui/toast', () => ({toast: mocks.toast}));
import { DomainsPage } from './domains-page';
import { ApiError } from '@/api/errors';

describe('domain configuration safety', () => {
  it('blocks adding until a failed GET is successfully retried', async () => {
    mocks.get.mockRejectedValueOnce(new Error('settings network error'));
    mocks.get.mockResolvedValue({domains:{revision:7,list:[{domain:'old.example',public:true,perUserLimit:2}]}});
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByRole('button', {name:'重新加载'});
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name:'重新加载'}));
    await screen.findByText('old.example');
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:7,domains:{list:[{domain:'old.example',public:true,perUserLimit:2},{domain:'new.example',public:false,perUserLimit:0,random:true}]}}));
    client.clear();
  });
  it('blocks adding while settings are still pending', () => {
    mocks.get.mockImplementation(() => new Promise(() => {})); mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    expect(screen.getByPlaceholderText('example.com')).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', {name:'添加'}).closest('form')!);
    expect(mocks.update).not.toHaveBeenCalled();
    client.clear();
  });
  it('reloads configuration on concurrent revision conflicts', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[]}});
    mocks.update.mockRejectedValueOnce(new ApiError('changed', {code:'conflict',httpStatus:409}));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('还没有配置收件域名');
    const calls = mocks.get.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(calls));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:expect.stringContaining('重新加载')}));
    client.clear();
  });
  it('已有域名时接入指南默认折叠，可手动展开', async () => {
    mocks.get.mockResolvedValue({domains:{revision:2,list:[{domain:'old.example',public:false,perUserLimit:0}]}});
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('old.example');
    const toggle = screen.getByRole('button', {name:/如何接入一个新域名/});
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('在 Cloudflare 为该域开启 Email Routing')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('在 Cloudflare 为该域开启 Email Routing')).toBeInTheDocument();
    client.clear();
  });
  it('还没有域名时接入指南默认展开', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[]}});
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('还没有配置收件域名');
    expect(screen.getByRole('button', {name:/如何接入一个新域名/})).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('在 Cloudflare 为该域开启 Email Routing')).toBeInTheDocument();
    client.clear();
  });
  it('参与随机生成开关：带当前 revision 提交完整列表，只改这一个域名', async () => {
    mocks.get.mockResolvedValue({domains:{revision:5,list:[{domain:'a.example',public:true,perUserLimit:2,random:true},{domain:'b.example',public:false,perUserLimit:0}]}});
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('a.example');
    // 旧数据没有 random 字段时按参与随机显示
    expect(screen.getByRole('switch', {name:'b.example 参与随机生成'})).toBeChecked();
    fireEvent.click(screen.getByRole('switch', {name:'a.example 参与随机生成'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:5,domains:{list:[{domain:'a.example',public:true,perUserLimit:2,random:false},{domain:'b.example',public:false,perUserLimit:0}]}}));
    client.clear();
  });
  it('显示每个域名的 Claude 统计与风险标记，不参与随机的域名有标记', async () => {
    mocks.get.mockResolvedValue({domains:{revision:3,list:[
      {domain:'wiped.example',public:false,perUserLimit:0,random:true},
      {domain:'paid.example',public:false,perUserLimit:0,random:true},
      {domain:'off.example',public:false,perUserLimit:0,random:false},
    ]}});
    mocks.stats.mockResolvedValueOnce([
      {domain:'wiped.example',accounts:3,suspended:3,paid:1,paidSuspended:1,pending:0,risk:'wiped'},
      {domain:'paid.example',accounts:5,suspended:2,paid:3,paidSuspended:2,pending:1,risk:'paid_suspended'},
      {domain:'off.example',accounts:0,suspended:0,paid:0,paidSuspended:0,pending:0,risk:null},
    ]);
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('全军覆没')).toBeInTheDocument();
    expect(screen.getByText('付费被封达阈值，已排除')).toBeInTheDocument();
    expect(screen.getByText('Claude：账号 5 · 封 2 · 付费 3 · 付费封 2 · 未注册 1')).toBeInTheDocument();
    expect(screen.getByText('Claude：暂无记录')).toBeInTheDocument();
    expect(screen.getByText('不参与随机')).toBeInTheDocument();
    expect(screen.getByRole('switch', {name:'off.example 参与随机生成'})).not.toBeChecked();
    client.clear();
  });
  it('Claude 统计加载失败不影响域名管理', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[{domain:'old.example',public:false,perUserLimit:0}]}});
    mocks.stats.mockRejectedValueOnce(new Error('stats down'));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('old.example');
    expect(await screen.findByText(/Claude 统计暂时加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'添加'})).toBeEnabled();
    client.clear();
  });
});
