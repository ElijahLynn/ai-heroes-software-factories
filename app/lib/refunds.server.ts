import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

/** The Refund Window: calendar days after the Purchase, inclusive. */
export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
/** Share of lessons completed at which a Refund Request can no longer be raised. */
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundIneligibleReason =
  | "no-purchase"
  | "open-refund-request"
  | "claimed-team-seat"
  | "outside-refund-window"
  | "watched-too-much"
  | "completed-too-much";

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      amount: number;
      lastDayInRefundWindow: string;
    }
  | { eligible: false; reason: RefundIneligibleReason };

// Compare whole days, not hours — a Purchase at 23:00 still gets its full
// fourteenth day.
function asDayString(when: Date) {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasOpenRefundRequest(purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
}

function hasClaimedTeamSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/**
 * Refund Eligibility: whether the learner can raise a Refund Request on their
 * latest Purchase of this course, and if so, how much they would get back.
 */
export function getRefundEligibility(
  userId: number,
  course: { id: number; price: number },
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, course.id);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasOpenRefundRequest(purchase.id)) {
    return { eligible: false, reason: "open-refund-request" };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (hasClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "claimed-team-seat" };
  }

  const purchasedDay = asDayString(new Date(purchase.createdAt));
  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInRefundWindow = asDayString(windowEnd);
  const today = asDayString(now);

  if (today < purchasedDay || today > lastDayInRefundWindow) {
    return { eligible: false, reason: "outside-refund-window" };
  }

  const lessonIds = getLessonIdsForCourse(course.id);

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  // A purchasing-power price is given back at the price that was paid, not at
  // the list price of the course.
  const amount =
    getDiscountForCountry(purchase.country) > 0
      ? purchase.amountPaid
      : course.price;

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount,
    lastDayInRefundWindow,
  };
}
