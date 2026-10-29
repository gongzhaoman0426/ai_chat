import {
  quickPreviewSchema,
  type QuickPreview,
} from '../../../../packages/contracts/src/commerce-extra';
import { DesktopLicense } from '../../../../packages/core/src/license';
import {
  transferPreviewSchema,
  type TransferPreview,
} from '../../../../packages/contracts/src/workbench';
import {
  orderRemarkPreviewSchema,
  type OrderRemarkPreview,
} from '../../../../packages/contracts/src/pdd-tools';
import {
  shipmentPreviewSchema,
  type ShipmentPreview,
} from '../../../../packages/contracts/src/commerce-tools';
import { openDatabase } from '../../../../packages/database/src/index';
import { Engine } from '../../../../packages/core/src/engine';
import { readLocalPlatformHistory } from '../../../../packages/core/src/platform-history';
import { Router } from '../../../../packages/core/src/router';
import { MastraAi } from '../../../../packages/ai/src/index';
import type { AppHost } from '../../../../packages/core/src/types';
import type { Method, IncomingMessage } from '../../../../packages/contracts/src/index';
import { uid, errorText } from '../../../../packages/core/src/util';
const parent = (
  process as unknown as {
    parentPort: {
      on: (event: string, handler: (event: { data: any }) => void) => void;
      postMessage: (data: unknown) => void;
    };
  }
).parentPort;
const requests = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
const hostCall = (method: string, args: unknown[]) =>
  new Promise<any>((resolve, reject) => {
    const id = uid();
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error(`桌面操作超时：${method}`));
    }, 180000);
    requests.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'host', id, method, args });
  });
const actionGuards = new Map<string, (preview: OrderRemarkPreview) => Promise<void>>();
const shipmentGuards = new Map<string, (preview: ShipmentPreview) => Promise<void>>();
const transferGuards = new Map<string, (preview: TransferPreview) => Promise<void>>();
const quickGuards = new Map<string, (preview: QuickPreview) => Promise<void>>();
const host: AppHost = {
  executeQuickAction: async (command, authorize) => {
    quickGuards.set(command.id, authorize);
    try {
      return await hostCall('executeQuickAction', [command]);
    } finally {
      quickGuards.delete(command.id);
    }
  },
  staff: (id) => hostCall('staff', [id]),
  executeTransfer: async (command, authorize) => {
    transferGuards.set(command.id, authorize);
    try {
      return await hostCall('executeTransfer', [command]);
    } finally {
      transferGuards.delete(command.id);
    }
  },
  markRead: (accountId, input) => hostCall('markRead', [accountId, input]),
  executeShipment: async (command, authorize) => {
    shipmentGuards.set(command.id, authorize);
    try {
      return await hostCall('executeShipment', [command]);
    } finally {
      shipmentGuards.delete(command.id);
    }
  },
  executeAction: async (command, authorize) => {
    actionGuards.set(command.id, authorize);
    try {
      return await hostCall('executeAction', [command]);
    } finally {
      actionGuards.delete(command.id);
    }
  },
  send: (c) => hostCall('send', [c]),
  query: (...a) => hostCall('query', a),
  secretPut: (...a) => hostCall('secretPut', a),
  secretGet: (...a) => hostCall('secretGet', a),
  pickFile: (...a) => hostCall('pickFile', a),
  pickFiles: (...a) => hostCall('pickFiles', a),
  saveFile: (...a) => hostCall('saveFile', a),
  validateImage: (d) => hostCall('validateImage', [d]),
  connect: (...a) => hostCall('connect', a),
  disconnect: (...a) => hostCall('disconnect', a),
  forgetPartition: (...a) => hostCall('forgetPartition', a),
  verify: (...a) => hostCall('verify', a),
  maintenance: (...a) => hostCall('maintenance', a),
  stageRestore: (...a) => hostCall('stageRestore', a),
};
let engine: Engine;
let ai: MastraAi;
let router: Router;
async function connectionAccounts() {
  const enabled = await engine.db.appSetting.findMany({
    where: { key: { startsWith: 'platform.autoconnect:' } },
  });
  const accounts = await engine.db.account.findMany({
    include: { store: { select: { platform: true } } },
    where: {
      id: {
        in: enabled
          .filter((s) => s.value === true)
          .map((s) => s.key.slice('platform.autoconnect:'.length)),
      },
    },
  });
  return accounts.map(({ store, ...account }) => ({ ...account, platform: store.platform }));
}
parent.on('message', async ({ data }) => {
  if (data.type === 'hostResult') {
    const p = requests.get(data.id);
    if (p) {
      clearTimeout(p.timer);
      requests.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    }
    return;
  }
  try {
    if (data.type === 'init') {
      const db = await openDatabase(data.dir);
      ai = new MastraAi(db, data.dir, host, data.nodeExecutable);
      await ai.initialize();
      engine = new Engine(db, data.dir, host, ai);
      const license = new DesktopLicense(db, data.dir, host, data.licenseConfig || {});
      engine.license = license;
      ai.license = license;
      license.onChanged = () => parent.postMessage({ type: 'changed' });
      await license.initialize();
      router = new Router(engine, ai, data.appVersion);
      engine.onChanged = () => parent.postMessage({ type: 'changed' });
      await engine.initialize();
      engine.start();
      parent.postMessage({ type: 'ready', accounts: await connectionAccounts() });
      return;
    }
    if (data.type === 'connections') {
      parent.postMessage({
        type: 'result',
        id: data.id,
        ok: true,
        result: await connectionAccounts(),
      });
      return;
    }
    if (data.type === 'call') {
      const result = await router.call(data.method as Method, data.input);
      parent.postMessage({ type: 'result', id: data.id, ok: true, result });
      return;
    }
    if (data.type === 'platform_shipment_guard') {
      const authorize = shipmentGuards.get(data.actionId);
      if (!authorize) throw new Error('发货操作已失效，禁止提交');
      await authorize(shipmentPreviewSchema.parse(data.preview));
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'platform_quick_guard') {
      const authorize = quickGuards.get(data.actionId);
      if (!authorize) throw new Error('操作已失效');
      await authorize(quickPreviewSchema.parse(data.preview));
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'platform_transfer_guard') {
      const authorize = transferGuards.get(data.actionId);
      if (!authorize) throw new Error('转接已失效，禁止提交');
      await authorize(transferPreviewSchema.parse(data.preview));
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'platform_action_guard') {
      const authorize = actionGuards.get(data.actionId);
      if (!authorize) throw new Error('订单操作已失效，禁止提交');
      await authorize(orderRemarkPreviewSchema.parse(data.preview));
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'connection') {
      const result = await engine.updateConnection(data.input);
      parent.postMessage({ type: 'result', id: data.id, ok: true, result });
      return;
    }
    if (data.type === 'account') {
      const result = await engine.registerAccount(data.input);
      parent.postMessage({ type: 'result', id: data.id, ok: true, result });
      return;
    }
    if (data.type === 'incoming') {
      const input = data.input as IncomingMessage;
      if (data.imageBytes) {
        const account = await engine.db.account.findUniqueOrThrow({
          where: { id: input.accountId },
        });
        const existing = await engine.db.message.findUnique({
          where: { storeId_externalId: { storeId: account.storeId, externalId: input.externalId } },
        });
        if (!existing)
          try {
            input.attachmentId = (
              await engine.knowledge.attach(
                account.storeId,
                Buffer.from(data.imageBytes),
                '平台图片',
              )
            ).id;
          } catch {
            /* The original message remains available if decoding fails. */
          }
      }
      await engine.ingest(input);
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'platform_local_history') {
      const result = await readLocalPlatformHistory(engine.db, data.input);
      parent.postMessage({ type: 'result', id: data.id, ok: true, result });
      return;
    }
    if (data.type === 'send_rejected') {
      await engine.completeSend(data.outboundId, {
        status: 'rejected',
        reason: String(data.reason).slice(0, 500),
      });
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'confirmed') {
      await engine.completeSend(data.outboundId, {
        status: 'confirmed',
        externalId: data.externalId,
      });
      parent.postMessage({ type: 'result', id: data.id, ok: true });
      return;
    }
    if (data.type === 'offline') {
      await engine.markOffline(data.accountId);
      return;
    }
    if (data.type === 'windowHidden') {
      await engine.setOpened(null);
      return;
    }
    if (data.type === 'shutdown') {
      await engine.stop();
      await engine.license?.close();
      await ai.close();
      await engine.db.$disconnect();
      parent.postMessage({ type: 'stopped' });
      process.exit(0);
    }
  } catch (e) {
    parent.postMessage({
      type: data.type === 'init' ? 'fatal' : 'result',
      id: data.id,
      ok: false,
      error: errorText(e),
    });
  }
});
