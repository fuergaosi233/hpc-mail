import { Download, Plus, Shuffle, Upload } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AutoAssignDialog } from './auto-assign-dialog';
import { BindingsTable } from './bindings-table';
import { ExportDialog } from './export-dialog';
import { ProxyFormDialog } from './proxy-form-dialog';
import { ProxyImportDialog } from './proxy-import-dialog';
import { ProxyStatsCard } from './proxy-stats-card';
import { ProxyTable } from './proxy-table';

type DialogKind = 'create' | 'import' | 'export' | 'assign' | null;

/** 代理池：库存（任意供应商）+ 地址 ↔ 代理绑定 */
export function ProxiesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'bindings' ? 'bindings' : 'inventory';
  const [dialog, setDialog] = useState<DialogKind>(null);
  const close = () => setDialog(null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <PageHeader
        title="代理池"
        description="为每个邮箱地址关联独立的代理配置，供自动化流程按地址取用（/v1/proxies/lookup，需 proxy.read 权限）。"
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog('import')}>
              <Upload className="size-4" />
              导入
            </Button>
            <Button variant="secondary" onClick={() => setDialog('export')}>
              <Download className="size-4" />
              导出
            </Button>
            <Button variant="secondary" onClick={() => setDialog('assign')}>
              <Shuffle className="size-4" />
              自动分配
            </Button>
            <Button onClick={() => setDialog('create')}>
              <Plus className="size-4" />
              添加代理
            </Button>
          </>
        }
      />

      <ProxyStatsCard />

      <Tabs
        value={tab}
        onValueChange={(value) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (value === 'bindings') next.set('tab', 'bindings');
              else next.delete('tab');
              return next;
            },
            { replace: true },
          )
        }
      >
        <TabsList aria-label="代理池视图">
          <TabsTrigger value="inventory">库存</TabsTrigger>
          <TabsTrigger value="bindings">绑定</TabsTrigger>
        </TabsList>
        <TabsContent value="inventory" className="mt-4">
          <ProxyTable />
        </TabsContent>
        <TabsContent value="bindings" className="mt-4">
          <BindingsTable />
        </TabsContent>
      </Tabs>

      <ProxyFormDialog open={dialog === 'create'} proxy={null} onClose={close} />
      <ProxyImportDialog open={dialog === 'import'} onClose={close} />
      <ExportDialog open={dialog === 'export'} onClose={close} />
      <AutoAssignDialog open={dialog === 'assign'} onClose={close} />
    </div>
  );
}
