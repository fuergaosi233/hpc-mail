import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api/query-keys';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({ captcha: vi.fn(), login: vi.fn(), toast: vi.fn() }));
vi.mock('./proxy-1024-api', () => ({ proxy1024Api: { captcha: mocks.captcha, login: mocks.login } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { safeImageSrc, SlideCaptchaDialog } from './slide-captcha-dialog';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const captcha = (id: string) => ({ captchaId: id, masterImage: PNG, tileImage: PNG, tileWidth: 60, tileHeight: 60, initialX: 0, initialY: 42 });

function mount(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlideCaptchaDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
  return { client, onClose };
}

beforeEach(() => vi.clearAllMocks());

describe('1024 滑块登录', () => {
  it('拖动滑块后提交 captchaId、x 与验证码给出的 y，成功写入状态缓存', async () => {
    mocks.captcha.mockResolvedValue(captcha('c1'));
    const status = { enabled: true, configured: true, session: 'ok', email: 'ops@example.com' };
    mocks.login.mockResolvedValue(status);
    const { client, onClose } = mount();
    const slider = await screen.findByRole('slider', { name: '拼图块位置' });
    expect(screen.getByAltText('拼图块')).toHaveStyle({ top: '42px', left: '0px' });
    fireEvent.change(slider, { target: { value: '137' } });
    expect(screen.getByAltText('拼图块')).toHaveStyle({ left: '137px' });
    fireEvent.click(screen.getByRole('button', { name: '提交登录' }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith({ captchaId: 'c1', x: 137, y: 42 }));
    expect(client.getQueryData(queryKeys.admin.proxy1024Status)).toEqual(status);
    expect(onClose).toHaveBeenCalled();
    client.clear();
  });

  it('登录失败显示原因并换一张验证码', async () => {
    mocks.captcha.mockResolvedValueOnce(captcha('c1')).mockResolvedValueOnce(captcha('c2'));
    mocks.login.mockRejectedValue(new ApiError('验证失败，请重试', { code: 'upstream_failed', httpStatus: 502 }));
    const { client, onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '提交登录' }));
    expect(await screen.findByText('验证失败，请重试')).toBeInTheDocument();
    await waitFor(() => expect(mocks.captcha).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();
    client.clear();
  });

  it('只接受 data: 图片，拒绝任意 URL', () => {
    expect(safeImageSrc(PNG)).toBe(PNG);
    expect(safeImageSrc('https://evil.example/x.png')).toBeNull();
    expect(safeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });
});
