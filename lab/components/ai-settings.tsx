"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { AI_PROTOCOL_ITEMS, AI_PROTOCOL_LABELS, type AiProtocol } from "@/lib/ai-endpoint";
import { loadAIConfig, saveAIConfig, type AIConfig } from "@/lib/ai";

export function AISettingsDialog({
  open, onClose, onSaved,
}: { open: boolean; onClose: () => void; onSaved?: (c: AIConfig | null) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState<AiProtocol>("auto");

  useEffect(() => {
    if (!open) return;
    const c = loadAIConfig();
    setBaseUrl(c?.baseUrl ?? "");
    setApiKey(c?.apiKey ?? "");
    setModel(c?.model ?? "");
    setProtocol(c?.protocol ?? "auto");
  }, [open]);

  const valid = !!(baseUrl.trim() && apiKey.trim() && model.trim());
  const save = () => {
    if (valid) {
      const c: AIConfig = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), protocol };
      saveAIConfig(c);
      onSaved?.(c);
    }
    onClose();
  };
  const clear = () => { saveAIConfig(null); onSaved?.(null); onClose(); };

  return (
    <Dialog.Root open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title>AI 端点配置</Dialog.Title>
        <Dialog.Description>
          歌词的 AI 分析用你自己的模型端点（OpenAI 兼容，chat/completions 或 responses 都行，默认自动适配）。
          请求经本站服务端中转，无 CORS 限制；配置只保存在本机 localStorage，
          密钥随请求透传、不记录不存储。
        </Dialog.Description>
        <div className="mt-4 grid gap-4">
          <Input label="Base URL" placeholder="https://api.deepseek.com/v1"
            value={baseUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)} />
          <Input label="API Key" type="password" placeholder="sk-…"
            value={apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)} />
          <Input label="模型" placeholder="deepseek-chat"
            value={model} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModel(e.target.value)} />
          <Select label="接口协议" value={protocol} items={[...AI_PROTOCOL_ITEMS]}
            onValueChange={(value: AiProtocol | null) => value && setProtocol(value)}
            renderValue={(value: AiProtocol) => AI_PROTOCOL_LABELS[value]} />
        </div>
        <div className="mt-6 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={clear}>清除配置</Button>
          <div className="flex gap-2">
            <Dialog.Close render={(p) => <Button variant="secondary" {...p}>取消</Button>} />
            <Button onClick={save} disabled={!valid}>保存到本机</Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
