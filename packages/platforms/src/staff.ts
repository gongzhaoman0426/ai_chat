import { staffSchema, type PlatformStaff } from '../../contracts/src/workbench';
import { pddPayload } from './pdd/queries';
import { douyinPayload } from './douyin/queries';
import { record } from './shared';
import { assert } from '../../core/src/util';
import type { PlatformId } from '../../contracts/src/platform';
import type { PlatformActionResult } from '../../contracts/src/commerce-tools';
import { isPddRejected, pddFailureReason } from './pdd/response';
import { kuaishouStaff } from './kuaishou/queries';
import { platformActionResultSchema } from '../../contracts/src/commerce-tools';

export function normalizeStaff(
  platform: PlatformId,
  raw: unknown,
  currentStaffId?: string,
): PlatformStaff[] {
  assert(platform !== 'goofish', '闲鱼尚未提供客服转接');
  if (platform === 'kuaishou')
    return kuaishouStaff(raw)
      .filter((s) => s.id !== currentStaffId)
      .map((s) =>
        staffSchema.parse({
          id: s.id,
          name: s.name,
          ...(s.statusText ? { statusText: s.statusText } : {}),
        }),
      );
  const payload = platform === 'pinduoduo' ? pddPayload(raw) : douyinPayload(raw);
  const p = record(payload);
  // PDD indexes csList by its chat-routing CS id. The row's id is the merchant
  // account id and can differ (notably for the main account). Native UI passes
  // the key to moveConversation, while self-exclusion uses the canonical account.
  const indexed =
    platform === 'pinduoduo' &&
    p.csList !== null &&
    typeof p.csList === 'object' &&
    !Array.isArray(p.csList)
      ? Object.entries(p.csList).map(([key, value]) => {
          const row = record(value);
          const id = row.id;
          assert(
            typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)),
            '平台客服 ID 无效',
          );
          assert(
            (row.csid == null || String(row.csid) === key) &&
              (row.cs_id == null || String(row.cs_id) === key),
            '平台客服 ID 与列表索引不一致',
          );
          return { ...row, csid: key };
        })
      : undefined;
  const list = Array.isArray(payload)
    ? payload
    : (indexed ??
      [p.csList, p.cs_list, p.staff_list, p.staffList, p.serviceList, p.list, p.data].find(
        Array.isArray,
      ));
  assert(Array.isArray(list), '平台客服列表结构尚未识别，请在原平台转接');
  assert(list.length <= 500, '平台客服列表超出上限');
  const staff = list.flatMap((raw) => {
    const row = record(raw);
    // Feige prefers staffIdStr; the legacy numeric staffId may have lost precision.
    const id =
      (platform === 'douyin' ? row.staffIdStr : undefined) ??
      row.csid ??
      row.cs_id ??
      row.staff_id ??
      row.staffId ??
      row.id;
    assert(
      typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)),
      '平台客服 ID 无效',
    );
    const staff = staffSchema.parse({
      id: String(id),
      name: [
        row.name,
        row.csName,
        row.cs_name,
        row.staff_name,
        row.staffName,
        platform === 'pinduoduo' ? row.nickname : undefined,
        row.username,
      ].find((name) => typeof name === 'string' && name.trim()),
      ...(typeof row.statusText === 'string' ? { statusText: row.statusText } : {}),
    });
    const selfId = indexed ? String(row.id) : staff.id;
    return selfId === currentStaffId ? [] : [staff];
  });
  return [...new Map(staff.map((s) => [s.id, s])).values()];
}

export function transferResult(platform: PlatformId, raw: unknown): PlatformActionResult {
  if (platform === 'kuaishou') return platformActionResultSchema.parse(raw);
  let r = record(raw),
    acknowledged = false;
  for (let depth = 0; depth < 4 && Object.keys(r).length; depth++) {
    const rejected =
      platform === 'pinduoduo'
        ? isPddRejected(r)
        : r.success === false ||
          ['code', 'st', 'status_code', 'err_no', 'errno', 'error_code'].some(
            (k) => r[k] != null && Number(r[k]) !== 0,
          ) ||
          (record(r.check_spam_resp).decision != null &&
            record(r.check_spam_resp).decision !== 'PASS');
    if (rejected)
      return {
        status: 'rejected',
        reasonCode: 'platform_rejected',
        message:
          platform === 'pinduoduo'
            ? `转接被拒绝${pddFailureReason(r)}`
            : `转接被拒绝：${String(r.message ?? r.msg ?? '请检查平台权限').slice(0, 300)}`,
      };
    acknowledged ||=
      r.success === true ||
      r.result === 'ok' ||
      (platform === 'douyin' && (r.code === 0 || r.status_code === 0));
    r = record(r.data ?? r.result);
  }
  if (acknowledged)
    return {
      status: 'confirmed',
      reasonCode: 'platform_acknowledged',
      message: '平台已确认转接，请在平台查看后续接待。',
    };
  return {
    status: 'unknown',
    reasonCode: 'receipt_missing',
    message: '已调用平台转接，但未取得明确回执。请打开原平台核对，勿重复提交。',
  };
}
