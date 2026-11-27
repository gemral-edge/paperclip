// Tab 5: Links & Channels — Quick copy panel + CTA mapping

import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";

const LINKS = {
  "MAIN": [
    { label: "Gemral Landing", url: "https://gemral.com" },
    { label: "App Store iOS", url: "https://apps.apple.com/app/gemral/id6738030817" },
    { label: "Support Email", url: "mailto:support@gemral.com" },
  ],
  "KHÓA HỌC": [
    { label: "7 Ngày Tần Số Gốc", url: "https://gemral.com/courses/7-ngay-tan-so-goc" },
    { label: "Tần Số Tình Yêu", url: "https://gemral.com/courses/tan-so-tinh-yeu" },
    { label: "Tư Duy Triệu Phú", url: "https://gemral.com/courses/tu-duy-trieu-phu" },
    { label: "Trading 3 Tier", url: "https://gemral.com/courses/trading-3-tier" },
  ],
  "PARTNERSHIP": [
    { label: "Đối Tác Thịnh Vượng", url: "https://gemral.com/partnership" },
  ],
  "SẢN PHẨM": [
    { label: "Tinh Thể Năng Lượng", url: "https://yinyangmasters.com" },
  ],
};

const SOCIAL_CHANNELS = [
  { platform: "📘 Facebook", name: "Gemral", url: "https://facebook.com/gemral" },
  { platform: "📘 Facebook", name: "Jennie Uyên Chu", url: "https://facebook.com/jennieuyenchu" },
  { platform: "🔴 YouTube", name: "Gemral", url: "https://youtube.com/@gemral" },
  { platform: "🎵 TikTok", name: "Jennie", url: "https://tiktok.com/@jennieuyenchu" },
  { platform: "📸 Instagram", name: "Jennie", url: "https://instagram.com/jennieuyenchu" },
  { platform: "📌 Pinterest", name: "Gemral", url: "https://pinterest.com/gemral" },
];

const CTA_RULES = [
  { context: '"Mở app" / "Tải app"', link: "App Store iOS" },
  { context: '"Đăng ký khóa học cụ thể"', link: "Landing page khóa đó" },
  { context: '"Xem khóa học chung"', link: "gemral.com" },
  { context: '"Nâng cấp Premium"', link: "Trading 3 Tier page" },
  { context: '"CTV / Đối tác"', link: "Đối Tác Thịnh Vượng" },
  { context: '"Cộng đồng"', link: "Facebook Gemral" },
  { context: '"Hỗ trợ"', link: "support@gemral.com" },
];

export function LinksTab() {
  const { pushToast } = useToast();
  const copy = (text: string) => {
    void copyToClipboard(text).then((ok) => {
      pushToast(ok ? { title: 'Đã copy', tone: 'success' } : { title: 'Không thể sao chép', body: 'Trình duyệt chặn quyền truy cập clipboard.', tone: 'error' });
    });
  };

  return (
    <div className="space-y-4">
      {/* Important Links */}
      {Object.entries(LINKS).map(([section, links]) => (
        <Card key={section} className="p-4">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">{section}</h3>
          <div className="space-y-1.5">
            {links.map(l => (
              <div key={l.url} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/30">
                <div>
                  <div className="text-sm font-medium">{l.label}</div>
                  <div className="text-[10px] text-muted-foreground truncate max-w-[300px]">{l.url}</div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => copy(l.url)}><Copy className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => window.open(l.url, '_blank')}><ExternalLink className="h-3 w-3" /></Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {/* Social Channels */}
      <Card className="p-4">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Social Channels</h3>
        <div className="space-y-1.5">
          {SOCIAL_CHANNELS.map((ch, i) => (
            <div key={i} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/30">
              <div className="flex items-center gap-2">
                <span>{ch.platform}</span>
                <span className="text-sm">{ch.name}</span>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => copy(ch.url)}><Copy className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => window.open(ch.url, '_blank')}><ExternalLink className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* CTA Mapping */}
      <Card className="p-4">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">CTA Mapping Rules</h3>
        <table className="w-full text-xs">
          <thead><tr className="border-b"><th className="px-2 py-1.5 text-left text-muted-foreground">Context</th><th className="px-2 py-1.5 text-left text-muted-foreground">Link đến</th></tr></thead>
          <tbody>
            {CTA_RULES.map((r, i) => (
              <tr key={i} className="border-b hover:bg-muted/30">
                <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.context}</td>
                <td className="px-2 py-1.5">{r.link}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
