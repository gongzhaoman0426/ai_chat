import {
  orderRemarkCommandSchema,
  orderRemarkPreviewSchema,
  type OrderRemarkCommand,
  type OrderRemarkPreview,
  type OrderRemarkState,
  type PlatformActionResult,
} from '../../../contracts/src/pdd-tools';
import { errorText } from '../../../core/src/util';
import { isPddRejected, pddFailureReason } from './response';

export interface OrderRemarkIO {
  ownsOrder(): Promise<boolean>;
  read(): Promise<OrderRemarkState>;
  authorize(preview: OrderRemarkPreview): Promise<void>;
  write(state: OrderRemarkState): Promise<unknown>;
}
const same = (a: OrderRemarkState, b: OrderRemarkState) =>
  a.remark === b.remark && a.tag === b.tag && a.tagName === b.tagName;
const result = (
  status: PlatformActionResult['status'],
  reasonCode: string,
  message: string,
): PlatformActionResult => ({ status, reasonCode, message });
// Read/merge/compare/write/readback. The PDD endpoint has no discovered CAS token;
// a different client can still race the final compare. Never claim an atomic append.
export async function executeOrderRemark(
  command: OrderRemarkCommand,
  io: OrderRemarkIO,
  options = { name: '拼多多', rejected: isPddRejected, failureReason: pddFailureReason },
): Promise<PlatformActionResult> {
  orderRemarkCommandSchema.parse(command);
  let submitted = false;
  try {
    if (!(await io.ownsOrder()))
      return result(
        'rejected',
        'order_unverified',
        '当前买家订单列表中无法核验该订单，请重新查询订单。',
      );
    const before = await io.read();
    const alreadyPresent = before.remark
      .split(/\r?\n/)
      .some((line) => line.trim() === command.note);
    const after = {
      ...before,
      remark: alreadyPresent
        ? before.remark
        : [before.remark, command.note].filter(Boolean).join('\n'),
    };
    if (after.remark.length > 300)
      return result(
        'rejected',
        'remark_too_long',
        '追加后超过平台 300 字限制，原备注未改动，请人工整理。',
      );
    if (!same(before, await io.read()))
      return result('rejected', 'remark_conflict', '其他客服已修改备注或标签，请重新查询后处理。');
    await io.authorize(orderRemarkPreviewSchema.parse({ before, after }));
    if (alreadyPresent)
      return result('confirmed', 'already_present', '订单中已有这条备注，无需重复添加。');
    submitted = true;
    let response: unknown;
    try {
      response = await io.write(after);
    } catch {
      /* Reconcile by a read, never resend. */
    }
    if (options.rejected(response))
      return result(
        'rejected',
        'platform_rejected',
        `${options.name}拒绝保存备注${options.failureReason(response)}，不能宣称已备注。`,
      );
    if (same(after, await io.read()))
      return result(
        'confirmed',
        'readback_confirmed',
        '订单备注已追加，并已从平台读回核对；原有标签保持不变。',
      );
    return result(
      'unknown',
      'readback_mismatch',
      '提交后读回内容不一致，可能有并发修改；请人工核对，不要自动重试。',
    );
  } catch (e) {
    return result(
      submitted ? 'unknown' : 'rejected',
      submitted ? 'confirmation_unavailable' : 'precondition_failed',
      submitted
        ? '备注提交结果无法确认，请人工核对，不要自动重试。'
        : `未提交订单备注：${errorText(e)}`,
    );
  }
}
