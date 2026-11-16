// Order List Page — Danh sách đơn hàng CRM + Tạo đơn modal

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Search, Plus, ShoppingBag } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { crmApi } from "@/api/crm";
import { SimpleModal } from "./components/SimpleModal";
import { useLiveInvalidate } from "@/hooks/useLiveInvalidate";

function formatVND(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(n || 0) + '₫';
}

function timeAgo(d?: string): string {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 3600000) return Math.round(ms / 60000) + ' phút trước';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' giờ trước';
  return Math.round(ms / 86400000) + ' ngày trước';
}

const statusLabels: Record<string, string> = {
  draft: 'Nháp', pending_payment: 'Chờ thanh toán', paid: 'Đã thanh toán',
  processing: 'Đang xử lý', shipped: 'Đã giao', delivered: 'Đã nhận',
  completed: 'Hoàn thành', cancelled: 'Đã hủy', refunded: 'Hoàn tiền',
};

const statusColors: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-600', pending_payment: 'bg-yellow-500/10 text-yellow-700',
  paid: 'bg-green-500/10 text-green-600', processing: 'bg-blue-500/10 text-blue-600',
  shipped: 'bg-purple-500/10 text-purple-600', delivered: 'bg-emerald-500/10 text-emerald-600',
  completed: 'bg-green-600/10 text-green-700', cancelled: 'bg-red-500/10 text-red-600',
  refunded: 'bg-orange-500/10 text-orange-600',
};

const PRODUCTS = [
  { value: 'tier1', label: 'TIER 1', price: 10999000 },
  { value: 'tier2', label: 'TIER 2', price: 20999000 },
  { value: 'tier3', label: 'TIER 3', price: 29999000 },
  { value: '7ngay', label: '7 Ngày', price: 1999000 },
  { value: 'tinhyeu', label: 'Tình Yêu', price: 399000 },
  { value: 'trieuphu', label: 'Triệu Phú', price: 499000 },
  { value: 'starter', label: 'Starter', price: 299000 },
];

const defaultOrderForm = {
  customer_name: '', customer_phone: '',
  product: '', quantity: 1, notes: '', payment_method: 'bank_transfer',
};

/**
 * @archetype list
 * @capability-skip dirty-guard: trang danh sách chỉ có ô tìm kiếm/bộ lọc; modal tạo đơn nhanh chọn sản phẩm từ danh mục cố định kèm tên/SĐT/ghi chú ngắn, nhập lại trong vài giây, không có bản nháp dài
 * @capability-skip empty-state: render trực tiếp nhánh isEmpty kèm nút xóa bộ lọc / tạo đơn mới
 */
export function OrderListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(defaultOrderForm);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['crm', 'orders', { search, status, page }],
    queryFn: () => crmApi.getOrders({
      ...(search && { search }),
      ...(status && { status }),
      page: String(page),
      limit: '25',
    }),
    staleTime: 15_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['crm', 'order-stats'],
    queryFn: () => crmApi.getOrderStats(),
    staleTime: 30_000,
  });

  // Live: auto-refresh khi crm_orders hoặc shopify_orders thay đổi (new order from webhook, status change)
  useLiveInvalidate({
    tables: ['crm_orders', 'shopify_orders'],
    queryKeys: [['crm', 'orders'], ['crm', 'order-stats'], ['crm', 'stats']],
  });

  const selectedProduct = PRODUCTS.find(p => p.value === form.product);
  const subtotal = selectedProduct ? selectedProduct.price * form.quantity : 0;
  const shippingFee = subtotal >= 500000 ? 0 : (subtotal > 0 ? 30000 : 0);
  const total = subtotal + shippingFee;

  const createMut = useMutation({
    mutationFn: (d: any) => crmApi.createOrder(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      setShowCreate(false);
      setForm(defaultOrderForm);
    },
  });

  const handleCreate = () => {
    if (!selectedProduct) return;
    createMut.mutate({
      items: [{ title: selectedProduct.label, price: selectedProduct.price, quantity: form.quantity, sku: form.product }],
      shipping_name: form.customer_name || undefined,
      shipping_phone: form.customer_phone || undefined,
      payment_method: form.payment_method,
      customer_note: form.notes || undefined,
      source: 'manual',
    });
  };

  const orders = data?.data || [];
  const hasFilters = Boolean(search.trim() || status);
  const isEmpty = !isLoading && !error && orders.length === 0;
  const resetFilters = () => {
    setSearch('');
    setStatus('');
    setPage(1);
  };

  const openCreateModal = () => {
    createMut.reset();
    setForm(defaultOrderForm);
    setShowCreate(true);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Đơn hàng</h1>
        <Button size="sm" onClick={openCreateModal}>
          <Plus className="mr-1.5 h-4 w-4" />
          Tạo đơn hàng
        </Button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="flex gap-4 text-sm">
          <span className="text-muted-foreground">Tổng: <strong>{stats.total || 0}</strong></span>
          <span className="text-muted-foreground">Hôm nay: <strong>{stats.todayCount || 0}</strong></span>
          <span className="text-muted-foreground">Doanh thu: <strong>{formatVND(stats.totalRevenue || 0)}</strong></span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input aria-label="Tìm đơn hàng" placeholder="Tìm theo mã đơn, tên khách..." className="pl-9" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <select aria-label="Lọc trạng thái đơn hàng" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Tất cả trạng thái</option>
          <option value="draft">Nháp</option>
          <option value="pending_payment">Chờ thanh toán</option>
          <option value="paid">Đã thanh toán</option>
          <option value="processing">Đang xử lý</option>
          <option value="completed">Hoàn thành</option>
          <option value="cancelled">Đã hủy</option>
        </select>
      </div>

      {/* Table */}
      <Card>
        {isLoading ? (
          <div className="p-4 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : error ? (
          <div className="p-8 text-center space-y-3">
            <p role="alert" className="text-sm text-destructive">Lỗi tải dữ liệu: {(error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Thử lại</Button>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <ShoppingBag className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {hasFilters ? 'Không tìm thấy đơn hàng nào khớp bộ lọc.' : 'Chưa có đơn hàng nào.'}
            </p>
            {hasFilters ? (
              <Button size="sm" variant="outline" onClick={resetFilters}>Xóa bộ lọc</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={openCreateModal}>
                <Plus className="mr-1.5 h-4 w-4" /> Tạo đơn hàng
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Mã đơn</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Khách hàng</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Trạng thái</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Tổng tiền</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Nguồn</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Ngày tạo</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o: any) => (
                  <tr
                    key={o.id}
                    tabIndex={0}
                    className="border-b cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:bg-muted/40"
                    onClick={() => navigate(`/crm/orders/${o.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/crm/orders/${o.id}`); } }}
                  >
                    <td className="px-4 py-3 font-medium">{o.order_number}</td>
                    <td className="px-4 py-3">{o.customer?.display_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[o.status] || 'bg-muted'}`}>
                        {statusLabels[o.status] || o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatVND(parseFloat(o.total) || 0)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{o.source}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">{timeAgo(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">{data.total} đơn, trang {page}/{data.totalPages}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Trước</Button>
              <Button size="sm" variant="outline" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>Sau</Button>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ Create Order Modal ═══ */}
      <SimpleModal open={showCreate} onClose={() => setShowCreate(false)} title="Tạo đơn hàng mới" footer={<>
        <Button variant="outline" onClick={() => setShowCreate(false)}>Hủy</Button>
        <Button disabled={!form.product || createMut.isPending} onClick={handleCreate}>
          {createMut.isPending ? 'Đang tạo...' : `Tạo đơn ${total > 0 ? formatVND(total) : ''}`}
        </Button>
      </>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Tên khách hàng</label>
              <Input value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} placeholder="Tên khách..." />
            </div>
            <div>
              <label className="text-sm font-medium">Số điện thoại</label>
              <Input value={form.customer_phone} onChange={e => setForm(f => ({ ...f, customer_phone: e.target.value }))} placeholder="0xxx..." />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Sản phẩm *</label>
            <select value={form.product} onChange={e => setForm(f => ({ ...f, product: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="">-- Chọn sản phẩm --</option>
              {PRODUCTS.map(p => (
                <option key={p.value} value={p.value}>{p.label} — {formatVND(p.price)}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Số lượng</label>
              <Input type="number" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: Math.max(1, Number(e.target.value) || 1) }))} min="1" />
            </div>
            <div>
              <label className="text-sm font-medium">Thanh toán</label>
              <select value={form.payment_method} onChange={e => setForm(f => ({ ...f, payment_method: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="bank_transfer">Chuyển khoản</option>
                <option value="cod">COD</option>
                <option value="momo">MoMo</option>
                <option value="vnpay">VNPay</option>
              </select>
            </div>
          </div>
          {subtotal > 0 && (
            <div className="rounded-lg bg-muted/30 p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Tạm tính:</span><span>{formatVND(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Phí ship:</span><span>{shippingFee === 0 ? 'Miễn phí' : formatVND(shippingFee)}</span></div>
              <div className="flex justify-between font-semibold border-t pt-1"><span>Tổng cộng:</span><span>{formatVND(total)}</span></div>
            </div>
          )}
          <div>
            <label className="text-sm font-medium">Ghi chú</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Ghi chú thêm..." className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]" />
          </div>
          {createMut.isError && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
              {(createMut.error as Error).message}
            </p>
          )}
        </div>
      </SimpleModal>
    </div>
  );
}
