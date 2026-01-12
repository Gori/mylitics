import { query } from "./_generated/server";
import { v } from "convex/values";
import { getUserId, validateAppOwnership } from "./lib/authHelpers";
import {
  ONE_DAY_MS,
  ONE_WEEK_MS,
  THIRTY_DAYS_MS,
  ONE_YEAR_MS,
  DEFAULT_QUERY_LIMIT,
  SAMPLE_SIZE_SMALL,
  SAMPLE_SIZE_MEDIUM,
  SAMPLE_SIZE_STANDARD,
  PERCENTAGE_PRECISION,
} from "./lib/constants";

const DEFAULT_REVENUE_FORMAT = "whole" as const;

function getWeekStart(date: Date, weekStartDay: "monday" | "sunday"): Date {
  const weekStart = new Date(date);
  if (weekStartDay === "monday") {
    const dayOfWeek = date.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(date.getDate() - daysFromMonday);
  } else {
    weekStart.setDate(date.getDate() - date.getDay());
  }
  return weekStart;
}

// Shared churn rate calculation - single source of truth
// Formula: (churn count / starting paid subscribers) × 100
function calculateChurnRate(churnCount: number, startingPaidSubscribers: number): number {
  if (startingPaidSubscribers <= 0) return 0;
  const rate = (churnCount / startingPaidSubscribers) * 100;
  return Math.round((rate + Number.EPSILON) * 100) / 100; // Round to 2 decimals
}

// Shared ARPU calculation - single source of truth
// Formula: revenue / active subscribers
function calculateArpu(revenue: number, activeSubscribers: number): number {
  if (activeSubscribers <= 0) return 0;
  return Math.round((revenue / activeSubscribers + Number.EPSILON) * 100) / 100; // Round to 2 decimals
}

const HISTORY_METRICS = [
  "activeSubscribers",
  "trialSubscribers",
  "paidSubscribers",
  "monthlySubscribers",
  "yearlySubscribers",
  "cancellations",
  "churn",
  "churnRate",
  "firstPayments",
  "renewals",
  "refunds",
  "weeklyChargedRevenue",
  "weeklyRevenue",
  "weeklyProceeds",
  "monthlyChargedRevenue",
  "monthlyRevenue",
  "monthlyProceeds",
  "mrr",
  "arpu",
  "monthlyPlanChargedRevenue",
  "yearlyPlanChargedRevenue",
  "monthlyPlanRevenue",
  "yearlyPlanRevenue",
  "monthlyPlanProceeds",
  "yearlyPlanProceeds",
  "weeklyPlanChargedRevenueMonthly",
  "weeklyPlanChargedRevenueYearly",
  "weeklyPlanRevenueMonthly",
  "weeklyPlanRevenueYearly",
  "weeklyPlanProceedsMonthly",
  "weeklyPlanProceedsYearly",
] as const;

const FLOW_METRICS = [
  "cancellations",
  "churn",
  "firstPayments",
  "renewals",
  "refunds",
  "weeklyChargedRevenue",
  "weeklyRevenue",
  "weeklyProceeds",
  "monthlyChargedRevenue",
  "monthlyRevenue",
  "monthlyProceeds",
  "monthlyPlanChargedRevenue",
  "yearlyPlanChargedRevenue",
  "monthlyPlanRevenue",
  "yearlyPlanRevenue",
  "monthlyPlanProceeds",
  "yearlyPlanProceeds",
  "weeklyPlanChargedRevenueMonthly",
  "weeklyPlanChargedRevenueYearly",
  "weeklyPlanRevenueMonthly",
  "weeklyPlanRevenueYearly",
  "weeklyPlanProceedsMonthly",
  "weeklyPlanProceedsYearly",
] as const;

const FLOW_METRICS_SET = new Set<string>(FLOW_METRICS);

type MetricSnapshot = {
  platform: string;
  date: string;
  [key: string]: any;
};

function deriveActivePlatforms(snapshots: MetricSnapshot[]) {
  return new Set(
    snapshots
      .filter((s) => s.platform !== "unified")
      .map((s) => s.platform)
  );
}

async function buildWeeklyHistoryFromSnapshots({
  app,
  metric,
  snapshots,
}: {
  app: any;
  metric: string;
  snapshots: MetricSnapshot[];
}) {
  const useAppStoreRatioForGooglePlay = app.useAppStoreRatioForGooglePlay ?? false;
  const activePlatforms = deriveActivePlatforms(snapshots);

  const isChurnRate = metric === "churnRate";
  const isArpu = metric === "arpu";
  const isFlowMetric = FLOW_METRICS_SET.has(metric) || isChurnRate || isArpu;

  const weeklyData: Record<
    string,
    Record<
      string,
      {
        sum: number;
        last: number;
        lastDate: string;
        churnSum?: number;
        startingPaidSubs?: number;
        firstDate?: string;
        revenueSum?: number;
        lastActiveSubscribers?: number;
      }
    >
  > = {};

  const ratioByWeek: Record<
    string,
    {
      appStorePlanMonthly: number;
      appStorePlanYearly: number;
      appStoreMonthlySubs: number;
      appStoreYearlySubs: number;
      appStoreActiveSubs: number;
      appStoreTrialSubs: number;
      appStorePaidSubs: number;
      appStoreMRR: number;
      appStoreSubsDate: string;
      googleCharged: number;
      googleRevenue: number;
      googleProceeds: number;
      googlePaidSubs: number;
      googleActiveSubs: number;
      googleTrialSubs: number;
      googleMonthlySubs: number;
      googleYearlySubs: number;
      googleSubsDate: string;
    }
  > = {};

  for (const snap of snapshots) {
    if (snap.platform === "unified") continue;

    const date = new Date(snap.date);
    const weekStart = getWeekStart(date, app.weekStartDay || "monday");
    const weekKey = weekStart.toISOString().split("T")[0];

    if (!ratioByWeek[weekKey]) {
      ratioByWeek[weekKey] = {
        appStorePlanMonthly: 0,
        appStorePlanYearly: 0,
        appStoreMonthlySubs: 0,
        appStoreYearlySubs: 0,
        appStoreActiveSubs: 0,
        appStoreTrialSubs: 0,
        appStorePaidSubs: 0,
        appStoreMRR: 0,
        appStoreSubsDate: "",
        googleCharged: 0,
        googleRevenue: 0,
        googleProceeds: 0,
        googlePaidSubs: 0,
        googleActiveSubs: 0,
        googleTrialSubs: 0,
        googleMonthlySubs: 0,
        googleYearlySubs: 0,
        googleSubsDate: "",
      };
    }
    if (snap.platform === "appstore") {
      ratioByWeek[weekKey].appStorePlanMonthly += snap.monthlyPlanChargedRevenue || 0;
      ratioByWeek[weekKey].appStorePlanYearly += snap.yearlyPlanChargedRevenue || 0;
      const asMonthlySubs = snap.monthlySubscribers || 0;
      const asYearlySubs = snap.yearlySubscribers || 0;
      const asActiveSubs = snap.activeSubscribers || 0;
      const asTrialSubs = snap.trialSubscribers || 0;
      const asPaidSubs = snap.paidSubscribers || Math.max(0, asActiveSubs - asTrialSubs);
      const asMRR = snap.mrr || 0;
      if ((asMonthlySubs > 0 || asYearlySubs > 0 || asActiveSubs > 0) && (!ratioByWeek[weekKey].appStoreSubsDate || snap.date >= ratioByWeek[weekKey].appStoreSubsDate)) {
        ratioByWeek[weekKey].appStoreMonthlySubs = asMonthlySubs;
        ratioByWeek[weekKey].appStoreYearlySubs = asYearlySubs;
        ratioByWeek[weekKey].appStoreActiveSubs = asActiveSubs;
        ratioByWeek[weekKey].appStoreTrialSubs = asTrialSubs;
        ratioByWeek[weekKey].appStorePaidSubs = asPaidSubs;
        ratioByWeek[weekKey].appStoreMRR = asMRR;
        ratioByWeek[weekKey].appStoreSubsDate = snap.date;
      }
    } else if (snap.platform === "googleplay") {
      ratioByWeek[weekKey].googleCharged += snap.monthlyChargedRevenue || 0;
      ratioByWeek[weekKey].googleRevenue += snap.monthlyRevenue || 0;
      ratioByWeek[weekKey].googleProceeds += snap.monthlyProceeds || 0;
      ratioByWeek[weekKey].googleMonthlySubs = snap.monthlySubscribers || 0;
      ratioByWeek[weekKey].googleYearlySubs = snap.yearlySubscribers || 0;
      const snapActiveSubs = snap.activeSubscribers || 0;
      if (snapActiveSubs > 0 && (!ratioByWeek[weekKey].googleSubsDate || snap.date >= ratioByWeek[weekKey].googleSubsDate)) {
        ratioByWeek[weekKey].googlePaidSubs = snap.paidSubscribers || 0;
        ratioByWeek[weekKey].googleActiveSubs = snapActiveSubs || 0;
        ratioByWeek[weekKey].googleTrialSubs = snap.trialSubscribers || 0;
        ratioByWeek[weekKey].googleSubsDate = snap.date;
      }
    }

    if (!weeklyData[weekKey]) weeklyData[weekKey] = {} as any;
    const value = isChurnRate || isArpu ? 0 : (snap as any)[metric] || 0;
    const entry =
      weeklyData[weekKey][snap.platform] || {
        sum: 0,
        last: 0,
        lastDate: "",
        churnSum: 0,
        startingPaidSubs: 0,
        firstDate: "9999-99-99",
        revenueSum: 0,
        lastActiveSubscribers: 0,
      };
    entry.sum += value;
    if (snap.date >= entry.lastDate) {
      entry.last = value;
      entry.lastDate = snap.date;
    }

    if (isChurnRate) {
      entry.churnSum = (entry.churnSum || 0) + (snap.churn || 0);
      if (snap.date < (entry.firstDate || "9999-99-99")) {
        entry.startingPaidSubs = snap.paidSubscribers || 0;
        entry.firstDate = snap.date;
      }
    }

    if (isArpu) {
      entry.revenueSum = (entry.revenueSum || 0) + (snap.monthlyRevenue || 0);
      if (snap.date >= entry.lastDate) {
        entry.lastActiveSubscribers = snap.activeSubscribers || 0;
      }
    }

    weeklyData[weekKey][snap.platform] = entry;
  }

  const sortedWeeks = Object.keys(ratioByWeek).sort();
  let lastKnownGoogleSubs = { paidSubs: 0, activeSubs: 0, trialSubs: 0, monthlySubs: 0, yearlySubs: 0 };
  for (const week of sortedWeeks) {
    const r = ratioByWeek[week];
    if (r.googleActiveSubs > 0) {
      lastKnownGoogleSubs = {
        paidSubs: r.googlePaidSubs,
        activeSubs: r.googleActiveSubs,
        trialSubs: r.googleTrialSubs,
        monthlySubs: r.googleMonthlySubs,
        yearlySubs: r.googleYearlySubs,
      };
    } else if (lastKnownGoogleSubs.activeSubs > 0) {
      r.googlePaidSubs = lastKnownGoogleSubs.paidSubs;
      r.googleActiveSubs = lastKnownGoogleSubs.activeSubs;
      r.googleTrialSubs = lastKnownGoogleSubs.trialSubs;
      r.googleMonthlySubs = lastKnownGoogleSubs.monthlySubs;
      r.googleYearlySubs = lastKnownGoogleSubs.yearlySubs;
    }
  }

  const weeklyResult = Object.entries(weeklyData)
    .map(([week, platforms]) => {
      const platformsInWeek = new Set(Object.keys(platforms));
      const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));

      if (isChurnRate) {
        const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
          if (!p) return null;
          return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
        };
        const appstore = getChurnRate((platforms as any).appstore);
        const googleplay = getChurnRate((platforms as any).googleplay);
        const stripe = getChurnRate((platforms as any).stripe);

        const totalChurn =
          ((platforms as any).appstore?.churnSum || 0) +
          ((platforms as any).googleplay?.churnSum || 0) +
          ((platforms as any).stripe?.churnSum || 0);
        const totalStartingSubs =
          ((platforms as any).appstore?.startingPaidSubs || 0) +
          ((platforms as any).googleplay?.startingPaidSubs || 0) +
          ((platforms as any).stripe?.startingPaidSubs || 0);
        const unified = calculateChurnRate(totalChurn, totalStartingSubs);

        return { week, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData: true };
      }

      if (isArpu) {
        const getArpuValue = (p?: { revenueSum?: number; lastActiveSubscribers?: number }) => {
          if (!p) return null;
          return calculateArpu(p.revenueSum || 0, p.lastActiveSubscribers || 0);
        };
        const appstore = getArpuValue((platforms as any).appstore);
        const googleplay = getArpuValue((platforms as any).googleplay);
        const stripe = getArpuValue((platforms as any).stripe);

        const totalRevenue =
          ((platforms as any).appstore?.revenueSum || 0) +
          ((platforms as any).googleplay?.revenueSum || 0) +
          ((platforms as any).stripe?.revenueSum || 0);
        const totalActiveSubs =
          ((platforms as any).appstore?.lastActiveSubscribers || 0) +
          ((platforms as any).googleplay?.lastActiveSubscribers || 0) +
          ((platforms as any).stripe?.lastActiveSubscribers || 0);
        const unified = calculateArpu(totalRevenue, totalActiveSubs);

        return { week, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData: true };
      }

      const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
      const appstore = val((platforms as any).appstore);
      let googleplay = val((platforms as any).googleplay);
      const stripe = val((platforms as any).stripe);

      let googleplayDerived = false;

      const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
      if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
        googleplay = null;
      }

      if (useAppStoreRatioForGooglePlay && (googleplay === null || googleplay === 0)) {
        const ratioInfo = ratioByWeek[week];
        const totalPlan = (ratioInfo?.appStorePlanMonthly || 0) + (ratioInfo?.appStorePlanYearly || 0);
        if (ratioInfo && totalPlan > 0) {
          const monthlyRatio = ratioInfo.appStorePlanMonthly / totalPlan;
          const yearlyRatio = ratioInfo.appStorePlanYearly / totalPlan;

          const deriveFromTotals = () => {
            if (metric === "monthlyPlanChargedRevenue" || metric === "weeklyPlanChargedRevenueMonthly") {
              googleplay = Math.round(((ratioInfo.googleCharged || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanChargedRevenue" || metric === "weeklyPlanChargedRevenueYearly") {
              googleplay = Math.round(((ratioInfo.googleCharged || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "monthlyPlanRevenue" || metric === "weeklyPlanRevenueMonthly") {
              googleplay = Math.round(((ratioInfo.googleRevenue || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanRevenue" || metric === "weeklyPlanRevenueYearly") {
              googleplay = Math.round(((ratioInfo.googleRevenue || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "monthlyPlanProceeds" || metric === "weeklyPlanProceedsMonthly") {
              googleplay = Math.round(((ratioInfo.googleProceeds || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanProceeds" || metric === "weeklyPlanProceedsYearly") {
              googleplay = Math.round(((ratioInfo.googleProceeds || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "trialSubscribers" || metric === "paidSubscribers") {
              // Derive Google Play trial/paid from App Store ratio
              // This runs when Google Play has no trial data (trial = 0)
              const gpActive = ratioInfo.googleActiveSubs || 0;
              const asActive = ratioInfo.appStoreActiveSubs || 0;
              const asTrial = ratioInfo.appStoreTrialSubs || 0;
              if (gpActive > 0 && asActive > 0 && asTrial > 0) {
                const trialRatio = asTrial / asActive;
                const derivedTrials = Math.round(gpActive * trialRatio);
                const derivedPaid = Math.max(0, gpActive - derivedTrials);
                if (metric === "trialSubscribers") {
                  googleplay = derivedTrials;
                  googleplayDerived = true;
                } else {
                  googleplay = derivedPaid;
                  googleplayDerived = true;
                }
              }
            } else if (metric === "monthlySubscribers" || metric === "yearlySubscribers") {
              let baseSubs = ratioInfo.googlePaidSubs || 0;
              if (baseSubs === 0 && ratioInfo.googleActiveSubs > 0) {
                baseSubs = Math.max(0, ratioInfo.googleActiveSubs - (ratioInfo.googleTrialSubs || 0));
              }
              if (metric === "monthlySubscribers") {
                googleplay = Math.round(baseSubs * monthlyRatio);
                googleplayDerived = true;
              } else {
                googleplay = Math.round(baseSubs * yearlyRatio);
                googleplayDerived = true;
              }
            } else if (metric === "mrr") {
              // Derive Google Play MRR using App Store's MRR per subscriber ratio
              const gpPaidSubs = ratioInfo.googlePaidSubs || Math.max(0, (ratioInfo.googleActiveSubs || 0) - (ratioInfo.googleTrialSubs || 0));
              const asPaidSubs = ratioInfo.appStorePaidSubs || 0;
              const asMRR = ratioInfo.appStoreMRR || 0;
              
              if (gpPaidSubs > 0 && asPaidSubs > 0 && asMRR > 0) {
                const mrrPerSub = asMRR / asPaidSubs;
                googleplay = Math.round((gpPaidSubs * mrrPerSub + Number.EPSILON) * 100) / 100;
                googleplayDerived = true;
              }
            }
          };

          deriveFromTotals();
        }
      }
      
      // FALLBACK: Always derive Google Play trial/paid from App Store ratio when GP has no trial data
      // This runs regardless of useAppStoreRatioForGooglePlay setting
      if ((metric === "trialSubscribers" || metric === "paidSubscribers") && !googleplayDerived) {
        const ratioInfo = ratioByWeek[week];
        if (ratioInfo) {
          const gpActive = ratioInfo.googleActiveSubs || 0;
          const gpTrial = ratioInfo.googleTrialSubs || 0;
          const asActive = ratioInfo.appStoreActiveSubs || 0;
          const asTrial = ratioInfo.appStoreTrialSubs || 0;
          
          // Only derive if Google Play has no trial data but App Store does
          if (gpActive > 0 && gpTrial === 0 && asActive > 0 && asTrial > 0) {
            const trialRatio = asTrial / asActive;
            const derivedTrials = Math.round(gpActive * trialRatio);
            const derivedPaid = Math.max(0, gpActive - derivedTrials);
            
            if (metric === "trialSubscribers") {
              googleplay = derivedTrials;
              googleplayDerived = true;
            } else if (metric === "paidSubscribers") {
              googleplay = derivedPaid;
              googleplayDerived = true;
            }
          }
        }
      }

      const isCurrencyMetric = [
        "mrr",
        "weeklyRevenue",
        "weeklyProceeds",
        "monthlyChargedRevenue",
        "monthlyRevenue",
        "monthlyProceeds",
        "monthlyPlanChargedRevenue",
        "yearlyPlanChargedRevenue",
        "monthlyPlanRevenue",
        "yearlyPlanRevenue",
        "monthlyPlanProceeds",
        "yearlyPlanProceeds",
        "weeklyPlanChargedRevenueMonthly",
        "weeklyPlanChargedRevenueYearly",
        "weeklyPlanRevenueMonthly",
        "weeklyPlanRevenueYearly",
        "weeklyPlanProceedsMonthly",
        "weeklyPlanProceedsYearly",
      ].includes(metric);
      const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
      const unified = isCurrencyMetric ? Math.round((sum + Number.EPSILON) * 100) / 100 : sum;

      const hasValidStockData =
        !["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr", "arpu"].includes(metric) ||
        Array.from(activePlatforms).every((p) => {
          if (p === "appstore") return appstore !== null;
          if (p === "googleplay") return googleplay !== null;
          if (p === "stripe") return stripe !== null;
          return true;
        });

      const appstoreStatus: "real" | "unavailable" = appstore !== null ? "real" : "unavailable";
      const googleplayStatus: "real" | "derived" | "unavailable" = googleplay !== null ? (googleplayDerived ? "derived" : "real") : "unavailable";
      const stripeStatus: "real" | "unavailable" = stripe !== null ? "real" : "unavailable";

      return {
        week,
        appstore,
        googleplay,
        stripe,
        unified,
        hasAllPlatforms,
        hasValidStockData,
        appstoreStatus,
        googleplayStatus,
        stripeStatus,
      };
    })
    .map((w) => {
      const weekEnd = new Date(w.week);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const isCurrentOrFutureWeek = weekEnd >= new Date();
      const isIncomplete = !w.hasAllPlatforms || isCurrentOrFutureWeek || !w.hasValidStockData;

      return { ...w, isIncomplete };
    })
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-52);

  return weeklyResult;
}

async function buildMonthlyHistoryFromSnapshots({
  app,
  metric,
  snapshots,
}: {
  app: any;
  metric: string;
  snapshots: MetricSnapshot[];
}) {
  const useAppStoreRatioForGooglePlay = app.useAppStoreRatioForGooglePlay ?? false;
  const activePlatforms = deriveActivePlatforms(snapshots);

  const isChurnRate = metric === "churnRate";
  const isArpu = metric === "arpu";
  const isFlowMetric = FLOW_METRICS_SET.has(metric) || isChurnRate || isArpu;

  const ratioByMonth: Record<
    string,
    {
      appStorePlanMonthly: number;
      appStorePlanYearly: number;
      appStoreMonthlySubs: number;
      appStoreYearlySubs: number;
      appStoreActiveSubs: number;
      appStoreTrialSubs: number;
      appStorePaidSubs: number;
      appStoreMRR: number;
      appStoreSubsDate: string;
      googleCharged: number;
      googleRevenue: number;
      googleProceeds: number;
      googlePaidSubs: number;
      googleActiveSubs: number;
      googleTrialSubs: number;
      googleMonthlySubs: number;
      googleYearlySubs: number;
      googleSubsDate: string;
    }
  > = {};

  const monthlyData: Record<
    string,
    Record<
      string,
      {
        sum: number;
        last: number;
        lastDate: string;
        churnSum?: number;
        startingPaidSubs?: number;
        firstDate?: string;
        revenueSum?: number;
        lastActiveSubscribers?: number;
      }
    >
  > = {};

  for (const snap of snapshots) {
    if (snap.platform === "unified") continue;

    const monthKey = snap.date.substring(0, 7);

    if (!ratioByMonth[monthKey]) {
      ratioByMonth[monthKey] = {
        appStorePlanMonthly: 0,
        appStorePlanYearly: 0,
        appStoreMonthlySubs: 0,
        appStoreYearlySubs: 0,
        appStoreActiveSubs: 0,
        appStoreTrialSubs: 0,
        appStorePaidSubs: 0,
        appStoreMRR: 0,
        appStoreSubsDate: "",
        googleCharged: 0,
        googleRevenue: 0,
        googleProceeds: 0,
        googlePaidSubs: 0,
        googleActiveSubs: 0,
        googleTrialSubs: 0,
        googleMonthlySubs: 0,
        googleYearlySubs: 0,
        googleSubsDate: "",
      };
    }
    if (snap.platform === "appstore") {
      ratioByMonth[monthKey].appStorePlanMonthly += snap.monthlyPlanChargedRevenue || 0;
      ratioByMonth[monthKey].appStorePlanYearly += snap.yearlyPlanChargedRevenue || 0;
      const asMonthlySubs = snap.monthlySubscribers || 0;
      const asYearlySubs = snap.yearlySubscribers || 0;
      const asActiveSubs = snap.activeSubscribers || 0;
      const asTrialSubs = snap.trialSubscribers || 0;
      const asPaidSubs = snap.paidSubscribers || Math.max(0, asActiveSubs - asTrialSubs);
      const asMRR = snap.mrr || 0;
      if ((asMonthlySubs > 0 || asYearlySubs > 0 || asActiveSubs > 0) && (!ratioByMonth[monthKey].appStoreSubsDate || snap.date >= ratioByMonth[monthKey].appStoreSubsDate)) {
        ratioByMonth[monthKey].appStoreMonthlySubs = asMonthlySubs;
        ratioByMonth[monthKey].appStoreYearlySubs = asYearlySubs;
        ratioByMonth[monthKey].appStoreActiveSubs = asActiveSubs;
        ratioByMonth[monthKey].appStoreTrialSubs = asTrialSubs;
        ratioByMonth[monthKey].appStorePaidSubs = asPaidSubs;
        ratioByMonth[monthKey].appStoreMRR = asMRR;
        ratioByMonth[monthKey].appStoreSubsDate = snap.date;
      }
    } else if (snap.platform === "googleplay") {
      ratioByMonth[monthKey].googleCharged += snap.monthlyChargedRevenue || 0;
      ratioByMonth[monthKey].googleRevenue += snap.monthlyRevenue || 0;
      ratioByMonth[monthKey].googleProceeds += snap.monthlyProceeds || 0;
      const snapActiveSubs = snap.activeSubscribers || 0;
      if (snapActiveSubs > 0 && (!ratioByMonth[monthKey].googleSubsDate || snap.date >= ratioByMonth[monthKey].googleSubsDate)) {
        ratioByMonth[monthKey].googlePaidSubs = snap.paidSubscribers || 0;
        ratioByMonth[monthKey].googleActiveSubs = snapActiveSubs || 0;
        ratioByMonth[monthKey].googleTrialSubs = snap.trialSubscribers || 0;
        ratioByMonth[monthKey].googleMonthlySubs = snap.monthlySubscribers || 0;
        ratioByMonth[monthKey].googleYearlySubs = snap.yearlySubscribers || 0;
        ratioByMonth[monthKey].googleSubsDate = snap.date;
      }
    }
    
    if (!monthlyData[monthKey]) monthlyData[monthKey] = {} as any;
    const value = isChurnRate || isArpu ? 0 : (snap as any)[metric] || 0;
    const entry =
      monthlyData[monthKey][snap.platform] || {
        sum: 0,
        last: 0,
        lastDate: "",
        churnSum: 0,
        startingPaidSubs: 0,
        firstDate: "9999-99-99",
        revenueSum: 0,
        lastActiveSubscribers: 0,
      };
    entry.sum += value;
    if (snap.date >= entry.lastDate) {
      entry.last = value;
      entry.lastDate = snap.date;
    }

    if (isChurnRate) {
      entry.churnSum = (entry.churnSum || 0) + (snap.churn || 0);
      if (snap.date < (entry.firstDate || "9999-99-99")) {
        entry.startingPaidSubs = snap.paidSubscribers || 0;
        entry.firstDate = snap.date;
      }
    }

    if (isArpu) {
      entry.revenueSum = (entry.revenueSum || 0) + (snap.monthlyRevenue || 0);
      if (snap.date >= entry.lastDate) {
        entry.lastActiveSubscribers = snap.activeSubscribers || 0;
      }
    }

    monthlyData[monthKey][snap.platform] = entry;
  }

  const sortedMonths = Object.keys(ratioByMonth).sort();
  let lastKnownGoogleSubs = { paidSubs: 0, activeSubs: 0, trialSubs: 0, monthlySubs: 0, yearlySubs: 0 };
  for (const month of sortedMonths) {
    const r = ratioByMonth[month];
    if (r.googleActiveSubs > 0) {
      lastKnownGoogleSubs = {
        paidSubs: r.googlePaidSubs,
        activeSubs: r.googleActiveSubs,
        trialSubs: r.googleTrialSubs,
        monthlySubs: r.googleMonthlySubs,
        yearlySubs: r.googleYearlySubs,
      };
    } else if (lastKnownGoogleSubs.activeSubs > 0) {
      r.googlePaidSubs = lastKnownGoogleSubs.paidSubs;
      r.googleActiveSubs = lastKnownGoogleSubs.activeSubs;
      r.googleTrialSubs = lastKnownGoogleSubs.trialSubs;
      r.googleMonthlySubs = lastKnownGoogleSubs.monthlySubs;
      r.googleYearlySubs = lastKnownGoogleSubs.yearlySubs;
    }
  }

  const monthlyResult = Object.entries(monthlyData)
    .map(([month, platforms]) => {
      const platformsInMonth = new Set(Object.keys(platforms));
      const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInMonth.has(p));

      if (isChurnRate) {
        const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
          if (!p) return null;
          return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
        };
        const appstore = getChurnRate((platforms as any).appstore);
        const googleplay = getChurnRate((platforms as any).googleplay);
        const stripe = getChurnRate((platforms as any).stripe);

        const totalChurn =
          ((platforms as any).appstore?.churnSum || 0) +
          ((platforms as any).googleplay?.churnSum || 0) +
          ((platforms as any).stripe?.churnSum || 0);
        const totalStartingSubs =
          ((platforms as any).appstore?.startingPaidSubs || 0) +
          ((platforms as any).googleplay?.startingPaidSubs || 0) +
          ((platforms as any).stripe?.startingPaidSubs || 0);
        const unified = calculateChurnRate(totalChurn, totalStartingSubs);

        const appstoreStatus = (platforms as any).appstore ? ("real" as const) : ("unavailable" as const);
        const googleplayStatus = (platforms as any).googleplay ? ("real" as const) : ("unavailable" as const);
        const stripeStatus = (platforms as any).stripe ? ("real" as const) : ("unavailable" as const);

        return {
          month,
          appstore,
          googleplay,
          stripe,
          unified,
          hasAllPlatforms,
          hasValidStockData: true,
          appstoreStatus,
          googleplayStatus,
          stripeStatus,
        };
      }

      if (isArpu) {
        const getArpuValue = (p?: { revenueSum?: number; lastActiveSubscribers?: number }) => {
          if (!p) return null;
          return calculateArpu(p.revenueSum || 0, p.lastActiveSubscribers || 0);
        };
        const appstore = getArpuValue((platforms as any).appstore);
        const googleplay = getArpuValue((platforms as any).googleplay);
        const stripe = getArpuValue((platforms as any).stripe);

        const totalRevenue =
          ((platforms as any).appstore?.revenueSum || 0) +
          ((platforms as any).googleplay?.revenueSum || 0) +
          ((platforms as any).stripe?.revenueSum || 0);
        const totalActiveSubs =
          ((platforms as any).appstore?.lastActiveSubscribers || 0) +
          ((platforms as any).googleplay?.lastActiveSubscribers || 0) +
          ((platforms as any).stripe?.lastActiveSubscribers || 0);
        const unified = calculateArpu(totalRevenue, totalActiveSubs);

        const appstoreStatus = (platforms as any).appstore ? ("real" as const) : ("unavailable" as const);
        const googleplayStatus = (platforms as any).googleplay ? ("real" as const) : ("unavailable" as const);
        const stripeStatus = (platforms as any).stripe ? ("real" as const) : ("unavailable" as const);

        return {
          month,
          appstore,
          googleplay,
          stripe,
          unified,
          hasAllPlatforms,
          hasValidStockData: true,
          appstoreStatus,
          googleplayStatus,
          stripeStatus,
        };
      }

      const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
      const appstore = val((platforms as any).appstore);
      let googleplay = val((platforms as any).googleplay);
      const stripe = val((platforms as any).stripe);

      let googleplayDerived = false;

      const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
      if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
        googleplay = null;
      }

      if (useAppStoreRatioForGooglePlay && (googleplay === null || googleplay === 0)) {
        const ratioInfo = ratioByMonth[month];
        const totalPlan = (ratioInfo?.appStorePlanMonthly || 0) + (ratioInfo?.appStorePlanYearly || 0);
        if (ratioInfo && totalPlan > 0) {
          const monthlyRatio = ratioInfo.appStorePlanMonthly / totalPlan;
          const yearlyRatio = ratioInfo.appStorePlanYearly / totalPlan;

          const deriveFromTotals = () => {
            if (metric === "monthlyPlanChargedRevenue" || metric === "weeklyPlanChargedRevenueMonthly") {
              googleplay = Math.round(((ratioInfo.googleCharged || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanChargedRevenue" || metric === "weeklyPlanChargedRevenueYearly") {
              googleplay = Math.round(((ratioInfo.googleCharged || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "monthlyPlanRevenue" || metric === "weeklyPlanRevenueMonthly") {
              googleplay = Math.round(((ratioInfo.googleRevenue || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanRevenue" || metric === "weeklyPlanRevenueYearly") {
              googleplay = Math.round(((ratioInfo.googleRevenue || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "monthlyPlanProceeds" || metric === "weeklyPlanProceedsMonthly") {
              googleplay = Math.round(((ratioInfo.googleProceeds || 0) * monthlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "yearlyPlanProceeds" || metric === "weeklyPlanProceedsYearly") {
              googleplay = Math.round(((ratioInfo.googleProceeds || 0) * yearlyRatio + Number.EPSILON) * 100) / 100;
              googleplayDerived = true;
            } else if (metric === "trialSubscribers" || metric === "paidSubscribers") {
              // Derive Google Play trial/paid from App Store ratio
              // This runs when Google Play has no trial data (trial = 0)
              const gpActive = ratioInfo.googleActiveSubs || 0;
              const asActive = ratioInfo.appStoreActiveSubs || 0;
              const asTrial = ratioInfo.appStoreTrialSubs || 0;
              if (gpActive > 0 && asActive > 0 && asTrial > 0) {
                const trialRatio = asTrial / asActive;
                const derivedTrials = Math.round(gpActive * trialRatio);
                const derivedPaid = Math.max(0, gpActive - derivedTrials);
                if (metric === "trialSubscribers") {
                  googleplay = derivedTrials;
                  googleplayDerived = true;
                } else {
                  googleplay = derivedPaid;
                  googleplayDerived = true;
                }
              }
            } else if (metric === "monthlySubscribers" || metric === "yearlySubscribers") {
              let baseSubs = ratioInfo.googlePaidSubs || 0;
              if (baseSubs === 0 && ratioInfo.googleActiveSubs > 0) {
                baseSubs = Math.max(0, ratioInfo.googleActiveSubs - (ratioInfo.googleTrialSubs || 0));
              }
              if (metric === "monthlySubscribers") {
                googleplay = Math.round(baseSubs * monthlyRatio);
                googleplayDerived = true;
              } else {
                googleplay = Math.round(baseSubs * yearlyRatio);
                googleplayDerived = true;
              }
            } else if (metric === "mrr") {
              // Derive Google Play MRR using App Store's MRR per subscriber ratio
              const gpPaidSubs = ratioInfo.googlePaidSubs || Math.max(0, (ratioInfo.googleActiveSubs || 0) - (ratioInfo.googleTrialSubs || 0));
              const asPaidSubs = ratioInfo.appStorePaidSubs || 0;
              const asMRR = ratioInfo.appStoreMRR || 0;
              
              if (gpPaidSubs > 0 && asPaidSubs > 0 && asMRR > 0) {
                const mrrPerSub = asMRR / asPaidSubs;
                googleplay = Math.round((gpPaidSubs * mrrPerSub + Number.EPSILON) * 100) / 100;
                googleplayDerived = true;
              }
            }
          };

          deriveFromTotals();
        }
      }
      
      // FALLBACK: Always derive Google Play trial/paid from App Store ratio when GP has no trial data
      // This runs regardless of useAppStoreRatioForGooglePlay setting
      if ((metric === "trialSubscribers" || metric === "paidSubscribers") && !googleplayDerived) {
        const ratioInfo = ratioByMonth[month];
        if (ratioInfo) {
          const gpActive = ratioInfo.googleActiveSubs || 0;
          const gpTrial = ratioInfo.googleTrialSubs || 0;
          const asActive = ratioInfo.appStoreActiveSubs || 0;
          const asTrial = ratioInfo.appStoreTrialSubs || 0;
          
          // Only derive if Google Play has no trial data but App Store does
          if (gpActive > 0 && gpTrial === 0 && asActive > 0 && asTrial > 0) {
            const trialRatio = asTrial / asActive;
            const derivedTrials = Math.round(gpActive * trialRatio);
            const derivedPaid = Math.max(0, gpActive - derivedTrials);
            
            if (metric === "trialSubscribers") {
              googleplay = derivedTrials;
              googleplayDerived = true;
            } else if (metric === "paidSubscribers") {
              googleplay = derivedPaid;
              googleplayDerived = true;
            }
          }
        }
      }

      const isCurrencyMetric = [
        "mrr",
        "weeklyRevenue",
        "weeklyProceeds",
        "monthlyChargedRevenue",
        "monthlyRevenue",
        "monthlyProceeds",
        "monthlyPlanChargedRevenue",
        "yearlyPlanChargedRevenue",
        "monthlyPlanRevenue",
        "yearlyPlanRevenue",
        "monthlyPlanProceeds",
        "yearlyPlanProceeds",
        "weeklyPlanChargedRevenueMonthly",
        "weeklyPlanChargedRevenueYearly",
        "weeklyPlanRevenueMonthly",
        "weeklyPlanRevenueYearly",
        "weeklyPlanProceedsMonthly",
        "weeklyPlanProceedsYearly",
      ].includes(metric);
      const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
      const unified = isCurrencyMetric ? Math.round((sum + Number.EPSILON) * 100) / 100 : sum;

      const hasValidStockData =
        !["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr", "arpu"].includes(metric) ||
        Array.from(activePlatforms).every((p) => {
          if (p === "appstore") return appstore !== null;
          if (p === "googleplay") return googleplay !== null;
          if (p === "stripe") return stripe !== null;
          return true;
        });

      const appstoreStatus: "real" | "unavailable" = appstore !== null ? "real" : "unavailable";
      const googleplayStatus: "real" | "derived" | "unavailable" = googleplay !== null ? (googleplayDerived ? "derived" : "real") : "unavailable";
      const stripeStatus: "real" | "unavailable" = stripe !== null ? "real" : "unavailable";

      return {
        month,
        appstore,
        googleplay,
        stripe,
        unified,
        hasAllPlatforms,
        hasValidStockData,
        appstoreStatus,
        googleplayStatus,
        stripeStatus,
      };
    })
    .map((m) => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const isCurrentMonth = m.month === currentMonth;
      const isIncomplete = !m.hasAllPlatforms || isCurrentMonth || !m.hasValidStockData;

      return { ...m, isIncomplete };
    })
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  return monthlyResult;
}

export const getLatestMetrics = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);
    const useAppStoreRatioForGooglePlay = app.useAppStoreRatioForGooglePlay ?? false;

    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
    
    const dateRangeStart = thirtyDaysAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dateRangeEnd = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    const lastSync = Math.max(...connections.map((c) => c.lastSync || 0));
    const activePlatforms = new Set(connections.map((c) => c.platform));

    // Flow metrics (sum over 30 days for monthly, 7 days for weekly)
    const flowMetrics = [
      "cancellations",
      "churn",
      "firstPayments",
      "renewals",
      "weeklyChargedRevenue",
      "weeklyRevenue",
      "weeklyProceeds",
      "monthlyChargedRevenue",
      "monthlyRevenue",
      "monthlyProceeds",
    ];

    // Get the most recent snapshots for each platform (for stock metrics)
    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    // Get latest snapshot per platform for stock metrics
    // For Google Play, find the most recent snapshot with actual subscription data
    // (Google Play reports have ~2-3 day delay, so latest snapshot may have 0 subscribers)
    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};
    
    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      // Track the most recent snapshot with actual subscription data
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }
    
    // For Google Play, use subscription data from the most recent snapshot that has it
    if (latestByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      
      // If latest has 0 subscribers but we have older data with subscribers, use that
      if (latest.activeSubscribers === 0 && latestWithSubs && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    // Get 30-day snapshots for summing flow metrics
    const snapshots30 = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo.toISOString().split("T")[0]))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Find the most recent date with complete data from all active platforms
    const snapshotsByDate: Record<string, Set<string>> = {};
    for (const snap of snapshots30) {
      if (!snapshotsByDate[snap.date]) {
        snapshotsByDate[snap.date] = new Set();
      }
      snapshotsByDate[snap.date].add(snap.platform);
    }
    
    // Find the most recent date where all active platforms have data
    const sortedDates = Object.keys(snapshotsByDate).sort((a, b) => b.localeCompare(a)); // newest first
    let mostRecentCompleteDate = sortedDates[0] || today; // fallback to most recent date or today
    if (activePlatforms.size > 0) {
      for (const date of sortedDates) {
        const platformsOnDate = snapshotsByDate[date];
        const hasAllPlatforms = Array.from(activePlatforms).every(p => platformsOnDate.has(p));
        if (hasAllPlatforms) {
          mostRecentCompleteDate = date;
          break;
        }
      }
    }
    
    // Calculate 7-day date range ending at mostRecentCompleteDate
    const endDate = new Date(mostRecentCompleteDate);
    const sevenDaysAgo = new Date(endDate);
    sevenDaysAgo.setDate(endDate.getDate() - 6); // 7 days including the end date
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    // Filter snapshots for 7-day calculations
    const snapshots7 = snapshots30.filter(snap => 
      snap.date >= sevenDaysAgoStr && snap.date <= mostRecentCompleteDate
    );

    // Calculate 30-day sums for flow metrics by platform
    // Also track starting paid subscribers for churn rate calculation
    const flowSumsByPlatform: Record<string, any> = {};
    const startingPaidSubsByPlatform30: Record<string, number> = {};
    
    // Sort snapshots by date to find the earliest (starting) values
    const sortedSnapshots30 = [...snapshots30].sort((a, b) => a.date.localeCompare(b.date));
    
    for (const snap of sortedSnapshots30) {
      if (!flowSumsByPlatform[snap.platform]) {
        flowSumsByPlatform[snap.platform] = {
          cancellations: 0,
          churn: 0,
          firstPayments: 0,
          renewals: 0,
          refunds: 0,
          monthlyChargedRevenue: 0,
          monthlyRevenue: 0,
          monthlyProceeds: 0,
          // Plan-split revenue fields
          monthlyPlanChargedRevenue: 0,
          yearlyPlanChargedRevenue: 0,
          monthlyPlanRevenue: 0,
          yearlyPlanRevenue: 0,
          monthlyPlanProceeds: 0,
          yearlyPlanProceeds: 0,
        };
        // First snapshot for this platform = starting paid subscribers
        startingPaidSubsByPlatform30[snap.platform] = snap.paidSubscribers || 0;
      }
      flowSumsByPlatform[snap.platform].cancellations += snap.cancellations;
      flowSumsByPlatform[snap.platform].churn += snap.churn;
      flowSumsByPlatform[snap.platform].firstPayments += snap.firstPayments;
      flowSumsByPlatform[snap.platform].renewals += (snap.renewals || 0);
      flowSumsByPlatform[snap.platform].refunds += (snap.refunds || 0);
      flowSumsByPlatform[snap.platform].monthlyChargedRevenue += snap.monthlyChargedRevenue;
      flowSumsByPlatform[snap.platform].monthlyRevenue += snap.monthlyRevenue;
      flowSumsByPlatform[snap.platform].monthlyProceeds += (snap.monthlyProceeds || 0);
      // Plan-split revenue fields
      flowSumsByPlatform[snap.platform].monthlyPlanChargedRevenue += (snap.monthlyPlanChargedRevenue || 0);
      flowSumsByPlatform[snap.platform].yearlyPlanChargedRevenue += (snap.yearlyPlanChargedRevenue || 0);
      flowSumsByPlatform[snap.platform].monthlyPlanRevenue += (snap.monthlyPlanRevenue || 0);
      flowSumsByPlatform[snap.platform].yearlyPlanRevenue += (snap.yearlyPlanRevenue || 0);
      flowSumsByPlatform[snap.platform].monthlyPlanProceeds += (snap.monthlyPlanProceeds || 0);
      flowSumsByPlatform[snap.platform].yearlyPlanProceeds += (snap.yearlyPlanProceeds || 0);
    }

    // Calculate 7-day sums for weekly revenue and churn by platform
    const weeklySumsByPlatform: Record<string, any> = {};
    const startingPaidSubsByPlatform7: Record<string, number> = {};
    
    // Sort snapshots by date to find the earliest (starting) values
    const sortedSnapshots7 = [...snapshots7].sort((a, b) => a.date.localeCompare(b.date));
    
    for (const snap of sortedSnapshots7) {
      if (!weeklySumsByPlatform[snap.platform]) {
        weeklySumsByPlatform[snap.platform] = {
          weeklyChargedRevenue: 0,
          weeklyRevenue: 0,
          weeklyProceeds: 0,
          weeklyChurn: 0,
          // Plan-split revenue fields
          weeklyPlanChargedRevenueMonthly: 0,
          weeklyPlanChargedRevenueYearly: 0,
          weeklyPlanRevenueMonthly: 0,
          weeklyPlanRevenueYearly: 0,
          weeklyPlanProceedsMonthly: 0,
          weeklyPlanProceedsYearly: 0,
        };
        // First snapshot for this platform = starting paid subscribers
        startingPaidSubsByPlatform7[snap.platform] = snap.paidSubscribers || 0;
      }
      weeklySumsByPlatform[snap.platform].weeklyChargedRevenue += snap.monthlyChargedRevenue;
      weeklySumsByPlatform[snap.platform].weeklyRevenue += snap.monthlyRevenue;
      weeklySumsByPlatform[snap.platform].weeklyProceeds += (snap.monthlyProceeds || 0);
      weeklySumsByPlatform[snap.platform].weeklyChurn += snap.churn || 0;
      // Plan-split revenue fields
      weeklySumsByPlatform[snap.platform].weeklyPlanChargedRevenueMonthly += (snap.monthlyPlanChargedRevenue || 0);
      weeklySumsByPlatform[snap.platform].weeklyPlanChargedRevenueYearly += (snap.yearlyPlanChargedRevenue || 0);
      weeklySumsByPlatform[snap.platform].weeklyPlanRevenueMonthly += (snap.monthlyPlanRevenue || 0);
      weeklySumsByPlatform[snap.platform].weeklyPlanRevenueYearly += (snap.yearlyPlanRevenue || 0);
      weeklySumsByPlatform[snap.platform].weeklyPlanProceedsMonthly += (snap.monthlyPlanProceeds || 0);
      weeklySumsByPlatform[snap.platform].weeklyPlanProceedsYearly += (snap.yearlyPlanProceeds || 0);
    }

    // Build platformMap with correct values for each metric type
    const platformMap: Record<string, any> = {};
    for (const platform of ["appstore", "googleplay", "stripe"]) {
      const latest = latestByPlatform[platform];
      const flowSums = flowSumsByPlatform[platform];
      const weeklySums = weeklySumsByPlatform[platform];
      
      // Include platform if it has snapshots OR if it's a connected platform
      // Connected platforms need to be in the map so ratio calculations can work
      const isConnectedPlatform = activePlatforms.has(platform as "appstore" | "googleplay" | "stripe");
      if (!latest && !flowSums && !isConnectedPlatform) {
        continue;
      }
      
      // Stock metrics from latest snapshot, flow metrics from 30-day sums, weekly from 7-day sums
      // Calculate churn rates using the shared helper function
      const monthlyChurnRate = calculateChurnRate(
        flowSums?.churn || 0,
        startingPaidSubsByPlatform30[platform] || 0
      );
      const weeklyChurnRate = calculateChurnRate(
        weeklySums?.weeklyChurn || 0,
        startingPaidSubsByPlatform7[platform] || 0
      );
      
      // Calculate ARPU: revenue / active subscribers
      const platformActiveSubscribers = latest?.activeSubscribers || 0;
      const monthlyArpu = calculateArpu(flowSums?.monthlyRevenue || 0, platformActiveSubscribers);
      const weeklyArpu = calculateArpu(weeklySums?.weeklyRevenue || 0, platformActiveSubscribers);
      
      platformMap[platform] = {
        activeSubscribers: platformActiveSubscribers,
        trialSubscribers: latest?.trialSubscribers || 0,
        paidSubscribers: latest?.paidSubscribers || 0,
        mrr: latest?.mrr || 0,
        cancellations: flowSums?.cancellations || 0,
        churn: flowSums?.churn || 0,
        churnRate: monthlyChurnRate,
        weeklyChurnRate: weeklyChurnRate,
        arpu: monthlyArpu,
        weeklyArpu: weeklyArpu,
        firstPayments: flowSums?.firstPayments || 0,
        renewals: flowSums?.renewals || 0,
        refunds: flowSums?.refunds || 0,
        weeklyChargedRevenue: weeklySums?.weeklyChargedRevenue || 0,
        weeklyRevenue: weeklySums?.weeklyRevenue || 0,
        weeklyProceeds: weeklySums?.weeklyProceeds || 0,
        monthlyChargedRevenue: flowSums?.monthlyChargedRevenue || 0,
        monthlyRevenue: flowSums?.monthlyRevenue || 0,
        monthlyProceeds: flowSums?.monthlyProceeds || 0,
        monthlySubscribers: latest?.monthlySubscribers || 0,
        yearlySubscribers: latest?.yearlySubscribers || 0,
        // Plan-split revenue (30-day)
        monthlyPlanChargedRevenue: flowSums?.monthlyPlanChargedRevenue || 0,
        yearlyPlanChargedRevenue: flowSums?.yearlyPlanChargedRevenue || 0,
        monthlyPlanRevenue: flowSums?.monthlyPlanRevenue || 0,
        yearlyPlanRevenue: flowSums?.yearlyPlanRevenue || 0,
        monthlyPlanProceeds: flowSums?.monthlyPlanProceeds || 0,
        yearlyPlanProceeds: flowSums?.yearlyPlanProceeds || 0,
        // Plan-split revenue (7-day)
        weeklyPlanChargedRevenueMonthly: weeklySums?.weeklyPlanChargedRevenueMonthly || 0,
        weeklyPlanChargedRevenueYearly: weeklySums?.weeklyPlanChargedRevenueYearly || 0,
        weeklyPlanRevenueMonthly: weeklySums?.weeklyPlanRevenueMonthly || 0,
        weeklyPlanRevenueYearly: weeklySums?.weeklyPlanRevenueYearly || 0,
        weeklyPlanProceedsMonthly: weeklySums?.weeklyPlanProceedsMonthly || 0,
        weeklyPlanProceedsYearly: weeklySums?.weeklyPlanProceedsYearly || 0,
      };
    }
    
    // Calculate Google Play plan split from App Store ratio if setting is enabled
    if (useAppStoreRatioForGooglePlay && platformMap.googleplay && platformMap.appstore) {
      const appStore = platformMap.appstore;
      const googlePlay = platformMap.googleplay;
      
      // DERIVE TRIAL/PAID SUBSCRIBERS FROM APP STORE RATIO
      // Google Play reports don't have separate trial counts, so we estimate from App Store's ratio
      if (appStore.activeSubscribers > 0 && googlePlay.activeSubscribers > 0) {
        const appStoreTrialRatio = appStore.trialSubscribers / appStore.activeSubscribers;
        const estimatedGoogleTrials = Math.round(googlePlay.activeSubscribers * appStoreTrialRatio);
        const estimatedGooglePaid = Math.max(0, googlePlay.activeSubscribers - estimatedGoogleTrials);
        
        // Only override if Google Play has no trial data (trial = 0)
        if (googlePlay.trialSubscribers === 0 && estimatedGoogleTrials > 0) {
          platformMap.googleplay.trialSubscribers = estimatedGoogleTrials;
          platformMap.googleplay.paidSubscribers = estimatedGooglePaid;
        }
      }
      
      // Calculate App Store's monthly/yearly ratio from total revenue
      const appStoreTotal = appStore.monthlyPlanChargedRevenue + appStore.yearlyPlanChargedRevenue;
      const appStoreWeeklyTotal = appStore.weeklyPlanChargedRevenueMonthly + appStore.weeklyPlanChargedRevenueYearly;
      
      if (appStoreTotal > 0) {
        const monthlyRatio = appStore.monthlyPlanChargedRevenue / appStoreTotal;
        const yearlyRatio = appStore.yearlyPlanChargedRevenue / appStoreTotal;
        
        // Apply ratio to Google Play revenue
        platformMap.googleplay.monthlyPlanChargedRevenue = Math.round((googlePlay.monthlyChargedRevenue * monthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.yearlyPlanChargedRevenue = Math.round((googlePlay.monthlyChargedRevenue * yearlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.monthlyPlanRevenue = Math.round((googlePlay.monthlyRevenue * monthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.yearlyPlanRevenue = Math.round((googlePlay.monthlyRevenue * yearlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.monthlyPlanProceeds = Math.round((googlePlay.monthlyProceeds * monthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.yearlyPlanProceeds = Math.round((googlePlay.monthlyProceeds * yearlyRatio + Number.EPSILON) * 100) / 100;
        
        // Apply ratio to subscribers
        const monthlySubsExisting = googlePlay.monthlySubscribers ?? 0;
        const yearlySubsExisting = googlePlay.yearlySubscribers ?? 0;
        const totalSubs = monthlySubsExisting + yearlySubsExisting;
        if (totalSubs === 0) {
          // Derive subscriber counts from ratio - use paidSubscribers if available,
          // otherwise derive from activeSubscribers - trialSubscribers
          let baseSubs = googlePlay.paidSubscribers || 0;
          if (baseSubs === 0 && googlePlay.activeSubscribers > 0) {
            baseSubs = Math.max(0, googlePlay.activeSubscribers - (googlePlay.trialSubscribers || 0));
          }
          if (baseSubs > 0) {
            platformMap.googleplay.monthlySubscribers = Math.round(baseSubs * monthlyRatio);
            platformMap.googleplay.yearlySubscribers = Math.round(baseSubs * yearlyRatio);
          }
        }
      }
      
      if (appStoreWeeklyTotal > 0) {
        const weeklyMonthlyRatio = appStore.weeklyPlanChargedRevenueMonthly / appStoreWeeklyTotal;
        const weeklyYearlyRatio = appStore.weeklyPlanChargedRevenueYearly / appStoreWeeklyTotal;
        
        // Apply ratio to Google Play weekly revenue
        platformMap.googleplay.weeklyPlanChargedRevenueMonthly = Math.round((googlePlay.weeklyChargedRevenue * weeklyMonthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.weeklyPlanChargedRevenueYearly = Math.round((googlePlay.weeklyChargedRevenue * weeklyYearlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.weeklyPlanRevenueMonthly = Math.round((googlePlay.weeklyRevenue * weeklyMonthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.weeklyPlanRevenueYearly = Math.round((googlePlay.weeklyRevenue * weeklyYearlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.weeklyPlanProceedsMonthly = Math.round((googlePlay.weeklyProceeds * weeklyMonthlyRatio + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.weeklyPlanProceedsYearly = Math.round((googlePlay.weeklyProceeds * weeklyYearlyRatio + Number.EPSILON) * 100) / 100;
      }
      
      // IMPROVED: Calculate Google Play MRR using subscriber counts × App Store average prices
      // MRR Definition: subscriber count × monthly price contribution
      // - Monthly subs: MRR contribution = subscriber count × avg monthly price
      // - Yearly subs: MRR contribution = subscriber count × (avg yearly price / 12)
      //
      // We derive average prices from App Store's plan-specific data:
      // - Avg monthly price ≈ monthlyPlanChargedRevenue / monthlySubscribers
      // - Avg yearly price ≈ (yearlyPlanChargedRevenue × 12) / yearlySubscribers
      //   (yearly revenue is spread over 12 months, so multiply by 12 to get annual price)
      
      // Get Google Play subscriber counts (derive from paidSubscribers if monthly/yearly not available)
      let gpMonthlySubs = platformMap.googleplay.monthlySubscribers ?? 0;
      let gpYearlySubs = platformMap.googleplay.yearlySubscribers ?? 0;
      
      // If no monthly/yearly breakdown, derive from paid subscribers using App Store ratio
      if (gpMonthlySubs === 0 && gpYearlySubs === 0) {
        let baseSubs = googlePlay.paidSubscribers || 0;
        if (baseSubs === 0 && googlePlay.activeSubscribers > 0) {
          baseSubs = Math.max(0, googlePlay.activeSubscribers - (googlePlay.trialSubscribers || 0));
        }
        
        if (baseSubs > 0 && appStoreTotal > 0) {
          const monthlyRatio = appStore.monthlyPlanChargedRevenue / appStoreTotal;
          const yearlyRatio = appStore.yearlyPlanChargedRevenue / appStoreTotal;
          gpMonthlySubs = Math.round(baseSubs * monthlyRatio);
          gpYearlySubs = Math.round(baseSubs * yearlyRatio);
        }
      }
      
      // Calculate MRR using App Store's MRR per subscriber ratio
      // This is more accurate than using daily revenue per subscriber
      const asPaidSubs = appStore.paidSubscribers || Math.max(0, appStore.activeSubscribers - (appStore.trialSubscribers || 0));
      const gpPaidSubs = platformMap.googleplay.paidSubscribers || Math.max(0, googlePlay.activeSubscribers - (platformMap.googleplay.trialSubscribers || 0));
      
      if (gpPaidSubs > 0 && asPaidSubs > 0 && appStore.mrr > 0) {
        // Use App Store's MRR per paid subscriber as the basis
        const asMRRPerSub = appStore.mrr / asPaidSubs;
        const derivedMRR = Math.round((gpPaidSubs * asMRRPerSub + Number.EPSILON) * 100) / 100;
        
        platformMap.googleplay.mrr = derivedMRR;
      } else if (googlePlay.monthlyRevenue > 0) {
        // Fallback: Use 30-day revenue as approximation
        // This is less accurate but better than 0
        const derivedMRR = Math.round((googlePlay.monthlyRevenue + Number.EPSILON) * 100) / 100;
        platformMap.googleplay.mrr = derivedMRR;
      }
    }
    
    // FALLBACK: Always derive Google Play trial/paid from App Store ratio when GP has no trial data
    // This runs regardless of useAppStoreRatioForGooglePlay setting
    if (platformMap.googleplay && platformMap.appstore) {
      const gpActive = platformMap.googleplay.activeSubscribers || 0;
      const gpTrial = platformMap.googleplay.trialSubscribers || 0;
      const asActive = platformMap.appstore.activeSubscribers || 0;
      const asTrial = platformMap.appstore.trialSubscribers || 0;
      
      // Only derive if Google Play has no trial data but App Store does
      if (gpActive > 0 && gpTrial === 0 && asActive > 0 && asTrial > 0) {
        const trialRatio = asTrial / asActive;
        const derivedTrials = Math.round(gpActive * trialRatio);
        const derivedPaid = Math.max(0, gpActive - derivedTrials);
        
        platformMap.googleplay.trialSubscribers = derivedTrials;
        platformMap.googleplay.paidSubscribers = derivedPaid;
        console.log(`[Google Play Trial Fallback] Derived: trial=${derivedTrials}, paid=${derivedPaid} (from AS ratio ${(trialRatio*100).toFixed(1)}%)`);
      }
    }

    // Calculate unified by summing all platforms (use 0 if platform not in map)
    // For churn rate, calculate from total churn / total starting subscribers (not average of rates)
    const totalChurn = (platformMap.appstore?.churn || 0) + (platformMap.googleplay?.churn || 0) + (platformMap.stripe?.churn || 0);
    const totalStartingPaidSubs30 = (startingPaidSubsByPlatform30.appstore || 0) + (startingPaidSubsByPlatform30.googleplay || 0) + (startingPaidSubsByPlatform30.stripe || 0);
    const totalWeeklyChurn = (weeklySumsByPlatform.appstore?.weeklyChurn || 0) + (weeklySumsByPlatform.googleplay?.weeklyChurn || 0) + (weeklySumsByPlatform.stripe?.weeklyChurn || 0);
    const totalStartingPaidSubs7 = (startingPaidSubsByPlatform7.appstore || 0) + (startingPaidSubsByPlatform7.googleplay || 0) + (startingPaidSubsByPlatform7.stripe || 0);
    
    // Calculate unified ARPU from total revenue / total active subscribers
    const totalActiveSubscribers = (platformMap.appstore?.activeSubscribers || 0) + (platformMap.googleplay?.activeSubscribers || 0) + (platformMap.stripe?.activeSubscribers || 0);
    const totalMonthlyRevenue = (platformMap.appstore?.monthlyRevenue || 0) + (platformMap.googleplay?.monthlyRevenue || 0) + (platformMap.stripe?.monthlyRevenue || 0);
    const totalWeeklyRevenue = (platformMap.appstore?.weeklyRevenue || 0) + (platformMap.googleplay?.weeklyRevenue || 0) + (platformMap.stripe?.weeklyRevenue || 0);
    const totalMonthlyProceeds = (platformMap.appstore?.monthlyProceeds || 0) + (platformMap.googleplay?.monthlyProceeds || 0) + (platformMap.stripe?.monthlyProceeds || 0);
    const totalWeeklyProceeds = (platformMap.appstore?.weeklyProceeds || 0) + (platformMap.googleplay?.weeklyProceeds || 0) + (platformMap.stripe?.weeklyProceeds || 0);
    
    // For unified plan-split, only include Google Play if ratio setting is enabled
    const shouldIncludeGooglePlayInPlanSplit = useAppStoreRatioForGooglePlay && platformMap.googleplay;
    
    const unified = {
      activeSubscribers: totalActiveSubscribers,
      trialSubscribers: (platformMap.appstore?.trialSubscribers || 0) + (platformMap.googleplay?.trialSubscribers || 0) + (platformMap.stripe?.trialSubscribers || 0),
      paidSubscribers: (platformMap.appstore?.paidSubscribers || 0) + (platformMap.googleplay?.paidSubscribers || 0) + (platformMap.stripe?.paidSubscribers || 0),
      cancellations: (platformMap.appstore?.cancellations || 0) + (platformMap.googleplay?.cancellations || 0) + (platformMap.stripe?.cancellations || 0),
      churn: totalChurn,
      churnRate: calculateChurnRate(totalChurn, totalStartingPaidSubs30),
      weeklyChurnRate: calculateChurnRate(totalWeeklyChurn, totalStartingPaidSubs7),
      arpu: calculateArpu(totalMonthlyRevenue, totalActiveSubscribers),
      weeklyArpu: calculateArpu(totalWeeklyRevenue, totalActiveSubscribers),
      paybacks: 0,
      firstPayments: (platformMap.appstore?.firstPayments || 0) + (platformMap.googleplay?.firstPayments || 0) + (platformMap.stripe?.firstPayments || 0),
      renewals: (platformMap.appstore?.renewals || 0) + (platformMap.googleplay?.renewals || 0) + (platformMap.stripe?.renewals || 0),
      refunds: (platformMap.appstore?.refunds || 0) + (platformMap.googleplay?.refunds || 0) + (platformMap.stripe?.refunds || 0),
      weeklyChargedRevenue: Math.round(((platformMap.appstore?.weeklyChargedRevenue || 0) + (platformMap.googleplay?.weeklyChargedRevenue || 0) + (platformMap.stripe?.weeklyChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      weeklyRevenue: Math.round((totalWeeklyRevenue + Number.EPSILON) * 100) / 100,
      weeklyProceeds: Math.round((totalWeeklyProceeds + Number.EPSILON) * 100) / 100,
      mrr: Math.round(((platformMap.appstore?.mrr || 0) + (platformMap.googleplay?.mrr || 0) + (platformMap.stripe?.mrr || 0) + Number.EPSILON) * 100) / 100,
      monthlyChargedRevenue: Math.round(((platformMap.appstore?.monthlyChargedRevenue || 0) + (platformMap.googleplay?.monthlyChargedRevenue || 0) + (platformMap.stripe?.monthlyChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenue: Math.round((totalMonthlyRevenue + Number.EPSILON) * 100) / 100,
      monthlyProceeds: Math.round((totalMonthlyProceeds + Number.EPSILON) * 100) / 100,
      monthlySubscribers: (platformMap.appstore?.monthlySubscribers || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.monthlySubscribers || 0) : 0) + (platformMap.stripe?.monthlySubscribers || 0),
      yearlySubscribers: (platformMap.appstore?.yearlySubscribers || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.yearlySubscribers || 0) : 0) + (platformMap.stripe?.yearlySubscribers || 0),
      // Plan-split revenue (30-day) - only include Google Play if ratio setting is enabled
      monthlyPlanChargedRevenue: Math.round(((platformMap.appstore?.monthlyPlanChargedRevenue || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.monthlyPlanChargedRevenue || 0) : 0) + (platformMap.stripe?.monthlyPlanChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanChargedRevenue: Math.round(((platformMap.appstore?.yearlyPlanChargedRevenue || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.yearlyPlanChargedRevenue || 0) : 0) + (platformMap.stripe?.yearlyPlanChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      monthlyPlanRevenue: Math.round(((platformMap.appstore?.monthlyPlanRevenue || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.monthlyPlanRevenue || 0) : 0) + (platformMap.stripe?.monthlyPlanRevenue || 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanRevenue: Math.round(((platformMap.appstore?.yearlyPlanRevenue || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.yearlyPlanRevenue || 0) : 0) + (platformMap.stripe?.yearlyPlanRevenue || 0) + Number.EPSILON) * 100) / 100,
      monthlyPlanProceeds: Math.round(((platformMap.appstore?.monthlyPlanProceeds || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.monthlyPlanProceeds || 0) : 0) + (platformMap.stripe?.monthlyPlanProceeds || 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanProceeds: Math.round(((platformMap.appstore?.yearlyPlanProceeds || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.yearlyPlanProceeds || 0) : 0) + (platformMap.stripe?.yearlyPlanProceeds || 0) + Number.EPSILON) * 100) / 100,
      // Plan-split revenue (7-day)
      weeklyPlanChargedRevenueMonthly: Math.round(((platformMap.appstore?.weeklyPlanChargedRevenueMonthly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanChargedRevenueMonthly || 0) : 0) + (platformMap.stripe?.weeklyPlanChargedRevenueMonthly || 0) + Number.EPSILON) * 100) / 100,
      weeklyPlanChargedRevenueYearly: Math.round(((platformMap.appstore?.weeklyPlanChargedRevenueYearly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanChargedRevenueYearly || 0) : 0) + (platformMap.stripe?.weeklyPlanChargedRevenueYearly || 0) + Number.EPSILON) * 100) / 100,
      weeklyPlanRevenueMonthly: Math.round(((platformMap.appstore?.weeklyPlanRevenueMonthly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanRevenueMonthly || 0) : 0) + (platformMap.stripe?.weeklyPlanRevenueMonthly || 0) + Number.EPSILON) * 100) / 100,
      weeklyPlanRevenueYearly: Math.round(((platformMap.appstore?.weeklyPlanRevenueYearly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanRevenueYearly || 0) : 0) + (platformMap.stripe?.weeklyPlanRevenueYearly || 0) + Number.EPSILON) * 100) / 100,
      weeklyPlanProceedsMonthly: Math.round(((platformMap.appstore?.weeklyPlanProceedsMonthly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanProceedsMonthly || 0) : 0) + (platformMap.stripe?.weeklyPlanProceedsMonthly || 0) + Number.EPSILON) * 100) / 100,
      weeklyPlanProceedsYearly: Math.round(((platformMap.appstore?.weeklyPlanProceedsYearly || 0) + (shouldIncludeGooglePlayInPlanSplit ? (platformMap.googleplay?.weeklyPlanProceedsYearly || 0) : 0) + (platformMap.stripe?.weeklyPlanProceedsYearly || 0) + Number.EPSILON) * 100) / 100,
    };

    return {
      unified,
      platformMap,
      flowMetrics,
      lastSync: lastSync || null,
      dateRange: `${dateRangeStart} - ${dateRangeEnd}`,
      connectedPlatforms: Array.from(activePlatforms),
      useAppStoreRatioForGooglePlay,
    } as const;
  },
});

export const getMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { appId, days = 30 }) => {
    await validateAppOwnership(ctx, appId);

    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) =>
        q.eq("appId", appId).eq("platform", "unified")
      )
      .order("desc")
      .take(days);

    return snapshots.reverse();
  },
});

export const getPlatformConnections = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    return connections.map((c) => ({
      _id: c._id,
      platform: c.platform,
      lastSync: c.lastSync,
      credentials: c.credentials,
    }));
  },
});

export const getUserPreferences = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);
    const userId = await getUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    const revenueFormat = user?.revenueFormat === "twoDecimals" ? "twoDecimals" : DEFAULT_REVENUE_FORMAT;
    const chartType = user?.chartType === "area" ? "area" : "line";

    return {
      currency: app.currency || "USD",
      revenueFormat,
      chartType,
    };
  },
});

export const getSyncLogs = query({
  args: {
    appId: v.id("apps"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { appId, limit = 50 }) => {
    await validateAppOwnership(ctx, appId);
    return await ctx.db
      .query("syncLogs")
      .withIndex("by_app_time", (q) => q.eq("appId", appId))
      .order("desc")
      .take(limit);
  },
});

export const getWeeklyMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    metric: v.string(),
  },
  handler: async (ctx, { appId, metric }) => {
    const app = await validateAppOwnership(ctx, appId);
    const oneYearAgo = new Date(Date.now() - ONE_YEAR_MS).toISOString().split("T")[0];
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    return buildWeeklyHistoryFromSnapshots({ app, metric, snapshots });
  },
});

export const getMonthlyMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    metric: v.string(),
  },
  handler: async (ctx, { appId, metric }) => {
    const app = await validateAppOwnership(ctx, appId);
    const oneYearAgo = new Date(Date.now() - ONE_YEAR_MS).toISOString().split("T")[0];

    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    return buildMonthlyHistoryFromSnapshots({ app, metric, snapshots });
  },
});

export const getExchangeRate = query({
  args: {
    fromCurrency: v.string(),
    toCurrency: v.string(),
  },
  handler: async (ctx, { fromCurrency, toCurrency }) => {
    // Same currency, no conversion needed
    if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) {
      return 1;
    }

    // Get the most recent exchange rate
    const rate = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q) => 
        q.eq("fromCurrency", fromCurrency.toUpperCase()).eq("toCurrency", toCurrency.toUpperCase())
      )
      .order("desc")
      .first();

    if (rate) {
      return rate.rate;
    }

    // If no direct rate, try inverse
    const inverseRate = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q) => 
        q.eq("fromCurrency", toCurrency.toUpperCase()).eq("toCurrency", fromCurrency.toUpperCase())
      )
      .order("desc")
      .first();

    if (inverseRate) {
      return 1 / inverseRate.rate;
    }

    // Default to 1 if no rate found (will need to be fetched)
    return 1;
  },
});

export const getAllDebugData = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);

    const metrics = Array.from(HISTORY_METRICS);
    const flowMetrics = Array.from(FLOW_METRICS);

    const oneYearAgo = new Date(Date.now() - ONE_YEAR_MS).toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS).toISOString().split("T")[0];

    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    const activePlatforms = deriveActivePlatforms(snapshots);

    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};

    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }

    if (latestByPlatform.googleplay && latestWithSubsByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      if (latest.activeSubscribers === 0 && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    const snapshots30 = snapshots.filter((s) => s.date >= thirtyDaysAgo && s.platform !== "unified");

    const createEmptyFlowBucket = () => {
      const bucket: Record<string, number> = {};
      for (const key of flowMetrics) {
        bucket[key] = 0;
      }
      return bucket;
    };

    const getFlowValue = (snap: any, metric: string) => {
      if (metric === "weeklyChargedRevenue") return snap.weeklyChargedRevenue ?? snap.monthlyChargedRevenue ?? 0;
      if (metric === "weeklyRevenue") return snap.weeklyRevenue ?? snap.monthlyRevenue ?? 0;
      if (metric === "weeklyProceeds") return snap.weeklyProceeds ?? snap.monthlyProceeds ?? 0;
      return snap[metric] ?? 0;
    };

    const flowSumsByPlatform: Record<string, Record<string, number>> = {};
    for (const snap of snapshots30) {
      const platform = snap.platform;
      if (platform === "unified") continue;
      const bucket = flowSumsByPlatform[platform] ?? createEmptyFlowBucket();
      for (const metric of flowMetrics) {
        bucket[metric] += getFlowValue(snap, metric);
      }
      flowSumsByPlatform[platform] = bucket;
    }

    const weeklyDataByMetric: Record<string, any[]> = {};
    const monthlyDataByMetric: Record<string, any[]> = {};

    for (const metric of metrics) {
      weeklyDataByMetric[metric] = await buildWeeklyHistoryFromSnapshots({ app, metric, snapshots });
      monthlyDataByMetric[metric] = await buildMonthlyHistoryFromSnapshots({ app, metric, snapshots });
    }

    return {
      weeklyDataByMetric,
      monthlyDataByMetric,
      latestByPlatform,
      flowSumsByPlatform,
      flowMetrics,
      activePlatforms: Array.from(activePlatforms),
    };
  },
});

export const getChatContext = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);

    const currency = app.currency || "USD";

    // Get ALL latest snapshots (including platform-specific ones)
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    
    const allLatestSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .order("desc")
      .take(100);

    // Group by platform and get the most recent for each
    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};
    
    for (const snap of allLatestSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      // Track the most recent snapshot with actual subscription data
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }
    
    // For Google Play, prefer the snapshot with actual subscription data for stock metrics
    if (latestByPlatform.googleplay && latestWithSubsByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      
      if (latest.activeSubscribers === 0 && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    const latestMetrics = latestByPlatform.unified ? {
      ...latestByPlatform.unified,
      platformBreakdown: {
        appstore: latestByPlatform.appstore || null,
        googleplay: latestByPlatform.googleplay || null,
        stripe: latestByPlatform.stripe || null,
      }
    } : null;
    
    // Get 52 weeks of historical data
    const oneYearAgo = new Date(now.getTime() - ONE_YEAR_MS);
    
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo.toISOString().split("T")[0]))
      .collect();

    const metrics = [
      "activeSubscribers",
      "trialSubscribers",
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "cancellations",
      "churn",
      "firstPayments",
      "renewals",
      "mrr",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    const flowMetrics = [
      "cancellations",
      "churn",
      "firstPayments",
      "renewals",
      "monthlyChargedRevenue",
      "monthlyRevenue",
      "monthlyProceeds",
    ];

    // Calculate weekly data for each metric
    const weeklyData: Record<string, any[]> = {};

    for (const metric of metrics) {
      const weeklyDataMap: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
      const isFlowMetric = flowMetrics.includes(metric);

      for (const snap of snapshots) {
        if (snap.platform === "unified") continue;

        const date = new Date(snap.date);
        const weekStart = getWeekStart(date, app.weekStartDay || "monday");
        const weekKey = weekStart.toISOString().split("T")[0];

        if (!weeklyDataMap[weekKey]) weeklyDataMap[weekKey] = {} as any;
        const value = (snap as any)[metric] || 0;
        const entry = weeklyDataMap[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
        entry.sum += value;
        if (snap.date >= entry.lastDate) {
          entry.last = value;
          entry.lastDate = snap.date;
        }
        weeklyDataMap[weekKey][snap.platform] = entry;
      }

      // Stock metrics that should show null when value is 0 for Google Play
      const stockMetrics = [
        "activeSubscribers",
        "trialSubscribers", 
        "paidSubscribers",
        "monthlySubscribers",
        "yearlySubscribers",
        "mrr",
      ];
      const isStockMetric = stockMetrics.includes(metric);

      const result = Object.entries(weeklyDataMap)
        .map(([week, platforms]) => {
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : 0);
          const appstore = val((platforms as any).appstore);
          let googleplay: number | null = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber/stock metrics, treat 0 as null (no data)
          // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
          const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
          if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
            googleplay = null;
          }
          
          const unified = appstore + (googleplay ?? 0) + stripe;
          return { week, appstore, googleplay, stripe, unified };
        })
        .sort((a, b) => a.week.localeCompare(b.week))
        .slice(-52);

      weeklyData[metric] = result;
    }

    return {
      currency,
      latestMetrics,
      weeklyData,
      metricDefinitions: {
        activeSubscribers: "Total active subscriptions (trial + paid)",
        trialSubscribers: "Subscriptions currently in trial period",
        paidSubscribers: "Active paying subscriptions",
        monthlySubscribers: "Subscribers on monthly billing plans",
        yearlySubscribers: "Subscribers on yearly billing plans",
        cancellations: "Total cancellations in period",
        churn: "Subscribers who canceled (ended)",
        firstPayments: "New paying customers",
        renewals: "Subscription renewals",
        mrr: "Monthly Recurring Revenue",
        monthlyChargedRevenue: "Total charged to customers (including VAT)",
        monthlyRevenue: "Revenue excluding VAT (still includes platform fees)",
      },
    };
  },
});

export const debugRevenueCalculation = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - THIRTY_DAYS_MS).toISOString().split("T")[0];
    const today = new Date(now).toISOString().split("T")[0];

    // Get all snapshots for the past 30 days
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo))
      .collect();

    // Get all revenue events for the past 30 days (all platforms)
    const allRevenueEvents = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("timestamp"), new Date(thirtyDaysAgo).getTime()))
      .collect();

    const stripeEvents = allRevenueEvents.filter(e => e.platform === "stripe");
    const appstoreEvents = allRevenueEvents.filter(e => e.platform === "appstore");
    const googleplayEvents = allRevenueEvents.filter(e => e.platform === "googleplay");

    // Group snapshots by date and platform
    const snapshotsByDate: Record<string, any[]> = {};
    for (const snap of snapshots) {
      if (!snapshotsByDate[snap.date]) {
        snapshotsByDate[snap.date] = [];
      }
      snapshotsByDate[snap.date].push({
        platform: snap.platform,
        monthlyChargedRevenue: snap.monthlyChargedRevenue,
        monthlyRevenue: snap.monthlyRevenue,
        firstPayments: snap.firstPayments,
        renewals: snap.renewals,
      });
    }

    // Group revenue events by date and platform
    const eventsByDate: Record<string, any[]> = {};
    for (const event of allRevenueEvents) {
      const date = new Date(event.timestamp).toISOString().split("T")[0];
      const key = `${date}_${event.platform}`;
      if (!eventsByDate[key]) {
        eventsByDate[key] = [];
      }
      eventsByDate[key].push({
        platform: event.platform,
        eventType: event.eventType,
        amount: event.amount,
        currency: event.currency,
        timestamp: event.timestamp,
      });
    }

    // Check for duplicate snapshots (same date + platform)
    const snapshotsByDatePlatform: Record<string, number> = {};
    const duplicates: Array<{date: string, platform: string, count: number}> = [];
    
    for (const snap of snapshots) {
      const key = `${snap.date}_${snap.platform}`;
      snapshotsByDatePlatform[key] = (snapshotsByDatePlatform[key] || 0) + 1;
    }
    
    for (const [key, count] of Object.entries(snapshotsByDatePlatform)) {
      if (count > 1) {
        const [date, platform] = key.split('_');
        duplicates.push({ date, platform, count });
      }
    }

    // Calculate totals from snapshots
    const snapshotTotals = {
      stripe: { gross: 0, net: 0, count: 0 },
      appstore: { gross: 0, net: 0, count: 0 },
      googleplay: { gross: 0, net: 0, count: 0 },
      unified: { gross: 0, net: 0, count: 0 },
    };

    for (const snap of snapshots) {
      if (snap.platform === "stripe" || snap.platform === "appstore" || snap.platform === "googleplay") {
        snapshotTotals[snap.platform].gross += snap.monthlyChargedRevenue;
        snapshotTotals[snap.platform].net += snap.monthlyRevenue;
        snapshotTotals[snap.platform].count += 1;
      }
      if (snap.platform === "unified") {
        snapshotTotals.unified.gross += snap.monthlyChargedRevenue;
        snapshotTotals.unified.net += snap.monthlyRevenue;
        snapshotTotals.unified.count += 1;
      }
    }

    // Calculate totals from raw revenue events by platform
    const eventTotals = {
      stripe: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: stripeEvents.length,
      },
      appstore: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: appstoreEvents.length,
      },
      googleplay: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: googleplayEvents.length,
      },
    };

    for (const event of stripeEvents) {
      eventTotals.stripe.total += event.amount;
      eventTotals.stripe.byType[event.eventType] += event.amount;
    }
    
    for (const event of appstoreEvents) {
      eventTotals.appstore.total += event.amount;
      eventTotals.appstore.byType[event.eventType] += event.amount;
    }
    
    for (const event of googleplayEvents) {
      eventTotals.googleplay.total += event.amount;
      eventTotals.googleplay.byType[event.eventType] += event.amount;
    }

    return {
      dateRange: { start: thirtyDaysAgo, end: today },
      snapshotCount: snapshots.length,
      revenueEventCount: allRevenueEvents.length,
      duplicates,
      hasDuplicates: duplicates.length > 0,
      snapshotTotals,
      eventTotals,
      snapshotsByDate: Object.entries(snapshotsByDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 10), // Last 10 days
      eventsByDate: Object.entries(eventsByDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 10), // Last 10 days
      sampleSnapshotsStripe: snapshots
        .filter((s) => s.platform === "stripe")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleSnapshotsAppStore: snapshots
        .filter((s) => s.platform === "appstore")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleSnapshotsGooglePlay: snapshots
        .filter((s) => s.platform === "googleplay")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleEvents: allRevenueEvents
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10)
        .map((e) => ({
          date: new Date(e.timestamp).toISOString().split("T")[0],
          platform: e.platform,
          eventType: e.eventType,
          amount: e.amount,
          currency: e.currency,
        })),
    };
  },
});

// Validation query to cross-reference with actual platform dashboards
export const validateRevenueData = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Get snapshots for October 2025 (a recent full month for validation)
    const octStart = "2025-10-01";
    const octEnd = "2025-10-31";
    
    const octSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("date"), octStart),
        q.lte(q.field("date"), octEnd)
      ))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Calculate October totals by platform
    const octTotals: Record<string, { gross: number; net: number; days: number; avgDaily: number }> = {};
    for (const snap of octSnapshots) {
      if (!octTotals[snap.platform]) {
        octTotals[snap.platform] = { gross: 0, net: 0, days: 0, avgDaily: 0 };
      }
      octTotals[snap.platform].gross += snap.monthlyChargedRevenue;
      octTotals[snap.platform].net += snap.monthlyRevenue;
      octTotals[snap.platform].days += 1;
    }
    
    // Calculate averages
    for (const platform of Object.keys(octTotals)) {
      if (octTotals[platform].days > 0) {
        octTotals[platform].avgDaily = octTotals[platform].gross / octTotals[platform].days;
      }
    }

    // Get a few specific days of snapshots for manual verification
    const sampleDates = ["2025-10-15", "2025-10-20", "2025-10-25"];
    const sampleSnapshots: Record<string, Record<string, { gross: number; net: number }>> = {};
    
    for (const snap of octSnapshots) {
      if (sampleDates.includes(snap.date)) {
        if (!sampleSnapshots[snap.date]) sampleSnapshots[snap.date] = {};
        sampleSnapshots[snap.date][snap.platform] = {
          gross: snap.monthlyChargedRevenue,
          net: snap.monthlyRevenue,
        };
      }
    }

    // Calculate revenue split percentage
    const totalGross = Object.values(octTotals).reduce((sum, t) => sum + t.gross, 0);
    const revenueSplit: Record<string, string> = {};
    for (const [platform, totals] of Object.entries(octTotals)) {
      revenueSplit[platform] = totalGross > 0 
        ? `${((totals.gross / totalGross) * 100).toFixed(1)}%` 
        : "0%";
    }

    return {
      currency: userCurrency,
      period: "October 2025",
      instructions: "Compare these totals against your App Store Connect and Google Play Console reports for October 2025",
      octoberTotals: octTotals,
      revenueSplitPercentage: revenueSplit,
      totalAllPlatforms: {
        gross: totalGross,
        net: Object.values(octTotals).reduce((sum, t) => sum + t.net, 0),
      },
      sampleDaysForVerification: sampleSnapshots,
      snapshotCountByPlatform: Object.fromEntries(
        Object.entries(octTotals).map(([p, t]) => [p, t.days])
      ),
    };
  },
});

// COMPREHENSIVE DEBUG: Investigate all metric discrepancies for a specific month
export const debugMonthlyMetrics = query({
  args: { 
    appId: v.id("apps"),
    yearMonth: v.string(), // Format: "2024-11"
  },
  handler: async (ctx, { appId, yearMonth }) => {
    await validateAppOwnership(ctx, appId);
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Date range for the month
    const startDate = `${yearMonth}-01`;
    const endDate = `${yearMonth}-31`; // Will naturally cap at month end

    // 1. Get all snapshots for this month (all platforms)
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("date"), startDate),
        q.lte(q.field("date"), endDate)
      ))
      .collect();

    // Group snapshots by platform
    const snapshotsByPlatform: Record<string, typeof snapshots> = {};
    for (const snap of snapshots) {
      if (!snapshotsByPlatform[snap.platform]) {
        snapshotsByPlatform[snap.platform] = [];
      }
      snapshotsByPlatform[snap.platform].push(snap);
    }

    // Calculate totals per platform
    const platformTotals: Record<string, {
      days: number;
      // Stock metrics (use end-of-month)
      endOfMonthPaidSubscribers: number;
      endOfMonthActiveSubscribers: number;
      endOfMonthTrialSubscribers: number;
      endOfMonthMonthlySubscribers: number;
      endOfMonthYearlySubscribers: number;
      endOfMonthMRR: number;
      // Flow metrics (sum)
      totalCancellations: number;
      totalChurn: number;
      totalFirstPayments: number;
      totalRenewals: number;
      totalChargedRevenue: number;
      totalRevenue: number;
      totalProceeds: number;
      // Daily breakdown for debugging
      dailyBreakdown: Array<{
        date: string;
        paidSubs: number;
        cancellations: number;
        churn: number;
        firstPayments: number;
        renewals: number;
        chargedRevenue: number;
        revenue: number;
        proceeds: number;
      }>;
    }> = {};

    for (const [platform, snaps] of Object.entries(snapshotsByPlatform)) {
      if (platform === "unified") continue;
      
      const sorted = snaps.sort((a, b) => a.date.localeCompare(b.date));
      const lastDay = sorted[sorted.length - 1];
      
      platformTotals[platform] = {
        days: sorted.length,
        // Stock metrics from last day of month
        endOfMonthPaidSubscribers: lastDay?.paidSubscribers || 0,
        endOfMonthActiveSubscribers: lastDay?.activeSubscribers || 0,
        endOfMonthTrialSubscribers: lastDay?.trialSubscribers || 0,
        endOfMonthMonthlySubscribers: lastDay?.monthlySubscribers || 0,
        endOfMonthYearlySubscribers: lastDay?.yearlySubscribers || 0,
        endOfMonthMRR: lastDay?.mrr || 0,
        // Flow metrics summed
        totalCancellations: sorted.reduce((sum, s) => sum + (s.cancellations || 0), 0),
        totalChurn: sorted.reduce((sum, s) => sum + (s.churn || 0), 0),
        totalFirstPayments: sorted.reduce((sum, s) => sum + (s.firstPayments || 0), 0),
        totalRenewals: sorted.reduce((sum, s) => sum + (s.renewals || 0), 0),
        totalChargedRevenue: sorted.reduce((sum, s) => sum + (s.monthlyChargedRevenue || 0), 0),
        totalRevenue: sorted.reduce((sum, s) => sum + (s.monthlyRevenue || 0), 0),
        totalProceeds: sorted.reduce((sum, s) => sum + (s.monthlyProceeds || 0), 0),
        // Daily breakdown
        dailyBreakdown: sorted.map(s => ({
          date: s.date,
          paidSubs: s.paidSubscribers || 0,
          cancellations: s.cancellations || 0,
          churn: s.churn || 0,
          firstPayments: s.firstPayments || 0,
          renewals: s.renewals || 0,
          chargedRevenue: s.monthlyChargedRevenue || 0,
          revenue: s.monthlyRevenue || 0,
          proceeds: s.monthlyProceeds || 0,
        })),
      };
    }

    // 2. Get raw subscription data to check endDate population
    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();

    const subscriptionStats = {
      total: subscriptions.length,
      byPlatform: {} as Record<string, {
        total: number;
        withEndDate: number;
        withoutEndDate: number;
        statusCanceled: number;
        statusActive: number;
        statusTrialing: number;
        endedInMonth: number;
        startedInMonth: number;
      }>,
    };

    const monthStartMs = new Date(startDate).getTime();
    const monthEndMs = new Date(endDate).getTime() + ONE_DAY_MS;

    for (const sub of subscriptions) {
      if (!subscriptionStats.byPlatform[sub.platform]) {
        subscriptionStats.byPlatform[sub.platform] = {
          total: 0,
          withEndDate: 0,
          withoutEndDate: 0,
          statusCanceled: 0,
          statusActive: 0,
          statusTrialing: 0,
          endedInMonth: 0,
          startedInMonth: 0,
        };
      }
      const stats = subscriptionStats.byPlatform[sub.platform];
      stats.total++;
      if (sub.endDate) {
        stats.withEndDate++;
        if (sub.endDate >= monthStartMs && sub.endDate < monthEndMs) {
          stats.endedInMonth++;
        }
      } else {
        stats.withoutEndDate++;
      }
      if (sub.status === "canceled") stats.statusCanceled++;
      if (sub.status === "active") stats.statusActive++;
      if (sub.status === "trialing") stats.statusTrialing++;
      if (sub.startDate >= monthStartMs && sub.startDate < monthEndMs) {
        stats.startedInMonth++;
      }
    }

    // 3. Get revenue events for this month
    const revenueEvents = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("timestamp"), monthStartMs),
        q.lt(q.field("timestamp"), monthEndMs)
      ))
      .collect();

    const revenueEventStats = {
      total: revenueEvents.length,
      byPlatform: {} as Record<string, {
        total: number;
        firstPayments: number;
        renewals: number;
        refunds: number;
        totalAmount: number;
      }>,
    };

    for (const event of revenueEvents) {
      if (!revenueEventStats.byPlatform[event.platform]) {
        revenueEventStats.byPlatform[event.platform] = {
          total: 0,
          firstPayments: 0,
          renewals: 0,
          refunds: 0,
          totalAmount: 0,
        };
      }
      const stats = revenueEventStats.byPlatform[event.platform];
      stats.total++;
      if (event.eventType === "first_payment") stats.firstPayments++;
      if (event.eventType === "renewal") stats.renewals++;
      if (event.eventType === "refund") stats.refunds++;
      stats.totalAmount += event.amount;
    }

    // 4. Check App Store reports stored
    const appStoreReports = await ctx.db
      .query("appStoreReports")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("reportDate"), startDate),
        q.lte(q.field("reportDate"), endDate)
      ))
      .collect();

    const reportStats = {
      totalReports: appStoreReports.length,
      byType: {} as Record<string, number>,
    };
    for (const report of appStoreReports) {
      const key = `${report.reportType}/${report.reportSubType}`;
      reportStats.byType[key] = (reportStats.byType[key] || 0) + 1;
    }

    // Calculate unified totals
    const unifiedTotals = {
      endOfMonthPaidSubscribers: Object.values(platformTotals).reduce((sum, p) => sum + p.endOfMonthPaidSubscribers, 0),
      endOfMonthActiveSubscribers: Object.values(platformTotals).reduce((sum, p) => sum + p.endOfMonthActiveSubscribers, 0),
      totalCancellations: Object.values(platformTotals).reduce((sum, p) => sum + p.totalCancellations, 0),
      totalChurn: Object.values(platformTotals).reduce((sum, p) => sum + p.totalChurn, 0),
      totalFirstPayments: Object.values(platformTotals).reduce((sum, p) => sum + p.totalFirstPayments, 0),
      totalRenewals: Object.values(platformTotals).reduce((sum, p) => sum + p.totalRenewals, 0),
      totalChargedRevenue: Object.values(platformTotals).reduce((sum, p) => sum + p.totalChargedRevenue, 0),
      totalRevenue: Object.values(platformTotals).reduce((sum, p) => sum + p.totalRevenue, 0),
      totalProceeds: Object.values(platformTotals).reduce((sum, p) => sum + p.totalProceeds, 0),
      totalMRR: Object.values(platformTotals).reduce((sum, p) => sum + p.endOfMonthMRR, 0),
    };

    return {
      month: yearMonth,
      currency: userCurrency,
      platformTotals,
      unifiedTotals,
      subscriptionStats,
      revenueEventStats,
      appStoreReportStats: reportStats,
      diagnostics: {
        // Key metrics to compare with your data
        "YOUR_PAID_SUBS": "Compare unifiedTotals.endOfMonthPaidSubscribers with your 11,377",
        "YOUR_CANCELLATIONS": "Compare platformTotals.appstore.totalCancellations with your 1,400",
        "YOUR_FIRST_PAYMENTS": "Compare platformTotals.appstore.totalFirstPayments with your 933",
        "YOUR_REVENUE": "Compare unifiedTotals.totalRevenue with your 1.2mNOK for November",
        // Potential issues
        "SUBSCRIPTION_ENDDATE_CHECK": "If subscriptionStats.byPlatform.appstore.withoutEndDate is high, churn calculation will be wrong",
        "REVENUE_EVENT_CHECK": "revenueEventStats shows raw events - if total differs from snapshots, there's a processing issue",
      },
    };
  },
});

// DEBUG: Check Google Play specific data
export const debugGooglePlayData = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    // Get Google Play connection
    const gpConnection = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("platform"), "googleplay"))
      .first();

    // Get all Google Play snapshots
    const gpSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "googleplay"))
      .order("desc")
      .take(60); // Last 60 days

    // Get Google Play subscriptions
    const gpSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "googleplay"))
      .collect();

    // Analyze snapshots
    const snapshotsWithSubscribers = gpSnapshots.filter(s => s.activeSubscribers > 0 || s.paidSubscribers > 0);
    const snapshotsWithRevenue = gpSnapshots.filter(s => s.monthlyChargedRevenue > 0 || s.monthlyRevenue > 0);

    // Get date range
    const sortedSnapshots = [...gpSnapshots].sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = sortedSnapshots[0]?.date || "none";
    const lastDate = sortedSnapshots[sortedSnapshots.length - 1]?.date || "none";

    // Sample snapshots with and without subscriber data
    const sampleWithSubs = snapshotsWithSubscribers.slice(0, 5).map(s => ({
      date: s.date,
      active: s.activeSubscribers,
      paid: s.paidSubscribers,
      trial: s.trialSubscribers,
      monthly: s.monthlySubscribers,
      yearly: s.yearlySubscribers,
      mrr: s.mrr,
    }));

    const sampleWithRevenue = snapshotsWithRevenue.slice(0, 5).map(s => ({
      date: s.date,
      chargedRevenue: s.monthlyChargedRevenue,
      revenue: s.monthlyRevenue,
      proceeds: s.monthlyProceeds,
    }));

    return {
      connection: {
        exists: !!gpConnection,
        isActive: gpConnection?.isActive || false,
        lastSync: gpConnection?.lastSync ? new Date(gpConnection.lastSync).toISOString() : null,
      },
      snapshots: {
        total: gpSnapshots.length,
        withSubscriberData: snapshotsWithSubscribers.length,
        withRevenueData: snapshotsWithRevenue.length,
        dateRange: { first: firstDate, last: lastDate },
        sampleWithSubscribers: sampleWithSubs,
        sampleWithRevenue: sampleWithRevenue,
      },
      subscriptions: {
        total: gpSubscriptions.length,
        byStatus: {
          active: gpSubscriptions.filter(s => s.status === "active").length,
          canceled: gpSubscriptions.filter(s => s.status === "canceled").length,
          trialing: gpSubscriptions.filter(s => s.status === "trialing").length,
        },
      },
      diagnosis: {
        "SUBSCRIBER_DATA_MISSING": snapshotsWithSubscribers.length === 0 
          ? "NO subscription data in snapshots - check if GCS bucket has subscription reports"
          : `Found ${snapshotsWithSubscribers.length} days with subscriber data`,
        "REVENUE_VS_SUBS": snapshotsWithRevenue.length > 0 && snapshotsWithSubscribers.length === 0
          ? "Has revenue but NO subscriber data - financial reports exist but subscription reports missing"
          : "OK",
      },
    };
  },
});

// DEBUG: Revenue calculation breakdown for YTD vs 30-day
export const debugRevenueBreakdown = query({
  args: { 
    appId: v.id("apps"),
    year: v.optional(v.number()),
  },
  handler: async (ctx, { appId, year }) => {
    await validateAppOwnership(ctx, appId);
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    const targetYear = year || new Date().getFullYear();
    const yearStart = `${targetYear}-01-01`;
    const yearEnd = `${targetYear}-12-31`;

    // Get all snapshots for the year
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("date"), yearStart),
        q.lte(q.field("date"), yearEnd),
        q.neq(q.field("platform"), "unified")
      ))
      .collect();

    // Group by month and platform
    const monthlyByPlatform: Record<string, Record<string, {
      chargedRevenue: number;
      revenue: number;
      proceeds: number;
      days: number;
    }>> = {};

    for (const snap of snapshots) {
      const month = snap.date.substring(0, 7);
      if (!monthlyByPlatform[month]) {
        monthlyByPlatform[month] = {};
      }
      if (!monthlyByPlatform[month][snap.platform]) {
        monthlyByPlatform[month][snap.platform] = {
          chargedRevenue: 0,
          revenue: 0,
          proceeds: 0,
          days: 0,
        };
      }
      monthlyByPlatform[month][snap.platform].chargedRevenue += snap.monthlyChargedRevenue || 0;
      monthlyByPlatform[month][snap.platform].revenue += snap.monthlyRevenue || 0;
      monthlyByPlatform[month][snap.platform].proceeds += snap.monthlyProceeds || 0;
      monthlyByPlatform[month][snap.platform].days += 1;
    }

    // Calculate totals
    const monthlyTotals: Record<string, {
      chargedRevenue: number;
      revenue: number;
      proceeds: number;
      platforms: string[];
    }> = {};

    let ytdChargedRevenue = 0;
    let ytdRevenue = 0;
    let ytdProceeds = 0;

    for (const [month, platforms] of Object.entries(monthlyByPlatform)) {
      monthlyTotals[month] = {
        chargedRevenue: 0,
        revenue: 0,
        proceeds: 0,
        platforms: Object.keys(platforms),
      };
      for (const [platform, data] of Object.entries(platforms)) {
        monthlyTotals[month].chargedRevenue += data.chargedRevenue;
        monthlyTotals[month].revenue += data.revenue;
        monthlyTotals[month].proceeds += data.proceeds;
      }
      ytdChargedRevenue += monthlyTotals[month].chargedRevenue;
      ytdRevenue += monthlyTotals[month].revenue;
      ytdProceeds += monthlyTotals[month].proceeds;
    }

    // Calculate 30-day total (what dashboard shows)
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const last30DaySnapshots = snapshots.filter(s => s.date >= thirtyDaysAgoStr);
    const last30DayTotal = {
      chargedRevenue: last30DaySnapshots.reduce((sum, s) => sum + (s.monthlyChargedRevenue || 0), 0),
      revenue: last30DaySnapshots.reduce((sum, s) => sum + (s.monthlyRevenue || 0), 0),
      proceeds: last30DaySnapshots.reduce((sum, s) => sum + (s.monthlyProceeds || 0), 0),
      days: new Set(last30DaySnapshots.map(s => s.date)).size,
      dateRange: {
        start: thirtyDaysAgoStr,
        end: now.toISOString().split("T")[0],
      },
    };

    return {
      year: targetYear,
      currency: userCurrency,
      ytdTotals: {
        chargedRevenue: Math.round(ytdChargedRevenue * 100) / 100,
        revenue: Math.round(ytdRevenue * 100) / 100,
        proceeds: Math.round(ytdProceeds * 100) / 100,
      },
      last30DayTotal: {
        chargedRevenue: Math.round(last30DayTotal.chargedRevenue * 100) / 100,
        revenue: Math.round(last30DayTotal.revenue * 100) / 100,
        proceeds: Math.round(last30DayTotal.proceeds * 100) / 100,
        days: last30DayTotal.days,
        dateRange: last30DayTotal.dateRange,
      },
      monthlyBreakdown: monthlyTotals,
      monthlyByPlatform,
      explanation: {
        "DASHBOARD_BIG_NUMBER": "The dashboard shows 'last30DayTotal' - this is NOT year-to-date",
        "YTD_CALCULATION": "ytdTotals shows your actual year-to-date revenue",
        "YOUR_5.8M": "Compare ytdTotals.chargedRevenue with your 5.8mNOK",
        "YOUR_0.8M": "Compare last30DayTotal.chargedRevenue with your dashboard showing 0.8mNOK",
      },
    };
  },
});

// DEBUG: Analyze stored App Store reports to understand event classification
export const debugAppStoreReportContent = query({
  args: { 
    appId: v.id("apps"),
    reportDate: v.string(), // YYYY-MM-DD
  },
  handler: async (ctx, { appId, reportDate }) => {
    await validateAppOwnership(ctx, appId);

    // Find SUBSCRIBER report for this date
    const subscriberReports = await ctx.db
      .query("appStoreReports")
      .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("reportDate", reportDate))
      .filter((q) => q.eq(q.field("reportSubType"), "DETAILED"))
      .collect();

    // Find SUMMARY report for this date
    const summaryReports = await ctx.db
      .query("appStoreReports")
      .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("reportDate", reportDate))
      .filter((q) => q.eq(q.field("reportSubType"), "SUMMARY"))
      .collect();

    const result: any = {
      date: reportDate,
      subscriberReport: null,
      summaryReport: null,
    };

    // Analyze SUBSCRIBER (DETAILED) report - this is where events come from
    if (subscriberReports.length > 0) {
      const report = subscriberReports[0];
      const lines = report.content.trim().split(/\r?\n/);
      const headers = lines[0]?.split("\t").map(h => h.trim().toLowerCase()) || [];

      // Find column indices
      const eventIdx = headers.findIndex(h => /^event$/i.test(h));
      const eventDateIdx = headers.findIndex(h => /event.*date/i.test(h));
      const quantityIdx = headers.findIndex(h => /^quantity$/i.test(h));
      const customerPriceIdx = headers.findIndex(h => /customer\s*price/i.test(h));
      const proceedsIdx = headers.findIndex(h => /developer\s*proceeds|proceeds/i.test(h));
      const productIdIdx = headers.findIndex(h => /product.*id|subscription.*apple.*id/i.test(h));

      // Analyze all rows
      const eventBreakdown: Record<string, { count: number; revenue: number; rowsOnDate: number }> = {};
      let totalRows = 0;
      let rowsMatchingDate = 0;

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split("\t");
        totalRows++;

        const eventValue = eventIdx >= 0 ? (cols[eventIdx] || "").trim() : "(no event column)";
        const eventDateStr = eventDateIdx >= 0 ? (cols[eventDateIdx] || "").trim() : "";
        const quantity = quantityIdx >= 0 ? parseInt(cols[quantityIdx] || "1") : 1;
        const price = customerPriceIdx >= 0 ? parseFloat(cols[customerPriceIdx] || "0") : 0;

        // Normalize event date
        let normalizedDate = eventDateStr;
        if (eventDateStr.includes("/")) {
          const parts = eventDateStr.split("/");
          if (parts.length === 3) {
            normalizedDate = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
          }
        }

        const matchesDate = normalizedDate === reportDate;
        if (matchesDate) rowsMatchingDate++;

        const key = eventValue || "(empty)";
        if (!eventBreakdown[key]) {
          eventBreakdown[key] = { count: 0, revenue: 0, rowsOnDate: 0 };
        }
        eventBreakdown[key].count += quantity;
        eventBreakdown[key].revenue += price * quantity;
        if (matchesDate) {
          eventBreakdown[key].rowsOnDate += quantity;
        }
      }

      // Classify events as the code would
      const classifications: Record<string, string> = {};
      for (const eventVal of Object.keys(eventBreakdown)) {
        const lower = eventVal.toLowerCase();
        if (lower.includes("refund")) {
          classifications[eventVal] = "refund";
        } else if (lower.includes("cancel")) {
          classifications[eventVal] = "cancellation";
        } else if (lower.includes("rate after one year") || lower === "renew" || lower.includes("renewal")) {
          classifications[eventVal] = "renewal";
        } else if (lower.includes("start introductory price") ||
                   lower.includes("paid subscription from introductory price") ||
                   lower.includes("start promotional offer") ||
                   lower.includes("initial") ||
                   lower.includes("new") ||
                   lower.includes("subscribe")) {
          classifications[eventVal] = "first_payment";
        } else if (eventVal === "(empty)" || eventVal === "") {
          classifications[eventVal] = "renewal_default (empty event)";
        } else {
          classifications[eventVal] = "renewal_default (unknown)";
        }
      }

      result.subscriberReport = {
        totalRows,
        rowsMatchingDate,
        headers: headers.slice(0, 15), // First 15 headers
        columnIndices: { eventIdx, eventDateIdx, quantityIdx, customerPriceIdx, proceedsIdx, productIdIdx },
        eventBreakdown: Object.entries(eventBreakdown)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([event, stats]) => ({
            event,
            ...stats,
            classification: classifications[event],
          })),
        sampleRows: lines.slice(1, 6).map(line => line.split("\t").slice(0, 10)), // First 5 data rows, first 10 cols
      };
    }

    // Analyze SUMMARY report - this is where subscriber counts come from
    if (summaryReports.length > 0) {
      const report = summaryReports[0];
      const lines = report.content.trim().split(/\r?\n/);
      const headers = lines[0]?.split("\t").map(h => h.trim().toLowerCase()) || [];

      // Find subscriber-related columns
      const activeSubsIdx = headers.findIndex(h => /active.*subscri|subscri.*active/i.test(h));
      const activeTrialIdx = headers.findIndex(h => /active.*free.*trial|active.*trial|trial.*intro/i.test(h));
      const productIdIdx = headers.findIndex(h => /product.*id|sku|subscription.*name/i.test(h));

      // Sum up subscriber counts
      let totalActive = 0;
      let totalTrial = 0;
      const byProduct: Record<string, { active: number; trial: number }> = {};

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split("\t");
        const active = activeSubsIdx >= 0 ? parseInt(cols[activeSubsIdx] || "0") : 0;
        const trial = activeTrialIdx >= 0 ? parseInt(cols[activeTrialIdx] || "0") : 0;
        const productId = productIdIdx >= 0 ? (cols[productIdIdx] || "unknown").trim() : "unknown";

        totalActive += active;
        totalTrial += trial;

        if (!byProduct[productId]) {
          byProduct[productId] = { active: 0, trial: 0 };
        }
        byProduct[productId].active += active;
        byProduct[productId].trial += trial;
      }

      result.summaryReport = {
        totalRows: lines.length - 1,
        headers: headers.slice(0, 15),
        columnIndices: { activeSubsIdx, activeTrialIdx, productIdIdx },
        totals: { active: totalActive, trial: totalTrial, paid: totalActive - totalTrial },
        byProduct: Object.entries(byProduct)
          .sort((a, b) => b[1].active - a[1].active)
          .slice(0, 10),
        sampleRows: lines.slice(1, 6).map(line => line.split("\t").slice(0, 10)),
      };
    }

    return result;
  },
});

// Debug query for churn rate calculation
export const debugChurnRate = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - THIRTY_DAYS_MS).toISOString().split("T")[0];
    const sevenDaysAgo = new Date(now - ONE_WEEK_MS).toISOString().split("T")[0];

    // Get all snapshots for the past 30 days
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Sort by date
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

    // Group by platform
    const byPlatform: Record<string, typeof snapshots> = {};
    for (const snap of sorted) {
      if (!byPlatform[snap.platform]) byPlatform[snap.platform] = [];
      byPlatform[snap.platform].push(snap);
    }

    // Calculate churn rate breakdown for each platform
    const breakdown: Record<string, {
      totalChurn30d: number;
      startingPaidSubs30d: number;
      endingPaidSubs30d: number;
      calculatedChurnRate30d: number;
      totalChurn7d: number;
      startingPaidSubs7d: number;
      endingPaidSubs7d: number;
      calculatedChurnRate7d: number;
      dailySnapshots: Array<{ date: string; churn: number; paidSubs: number }>;
    }> = {};

    for (const [platform, snaps] of Object.entries(byPlatform)) {
      // 30-day data
      const first30d = snaps[0];
      const last30d = snaps[snaps.length - 1];
      const totalChurn30d = snaps.reduce((sum, s) => sum + (s.churn || 0), 0);
      const startingPaidSubs30d = first30d?.paidSubscribers || 0;
      const endingPaidSubs30d = last30d?.paidSubscribers || 0;
      
      // 7-day data
      const snaps7d = snaps.filter(s => s.date >= sevenDaysAgo);
      const first7d = snaps7d[0];
      const last7d = snaps7d[snaps7d.length - 1];
      const totalChurn7d = snaps7d.reduce((sum, s) => sum + (s.churn || 0), 0);
      const startingPaidSubs7d = first7d?.paidSubscribers || 0;
      const endingPaidSubs7d = last7d?.paidSubscribers || 0;

      breakdown[platform] = {
        totalChurn30d,
        startingPaidSubs30d,
        endingPaidSubs30d,
        calculatedChurnRate30d: calculateChurnRate(totalChurn30d, startingPaidSubs30d),
        totalChurn7d,
        startingPaidSubs7d,
        endingPaidSubs7d,
        calculatedChurnRate7d: calculateChurnRate(totalChurn7d, startingPaidSubs7d),
        // Include daily snapshots for debugging
        dailySnapshots: snaps.slice(-10).map(s => ({
          date: s.date,
          churn: s.churn || 0,
          paidSubs: s.paidSubscribers || 0,
        })),
      };
    }

    // Calculate unified totals
    const allPlatforms = Object.keys(breakdown);
    const unified30d = {
      totalChurn: allPlatforms.reduce((sum, p) => sum + breakdown[p].totalChurn30d, 0),
      startingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].startingPaidSubs30d, 0),
      endingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].endingPaidSubs30d, 0),
    };
    const unified7d = {
      totalChurn: allPlatforms.reduce((sum, p) => sum + breakdown[p].totalChurn7d, 0),
      startingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].startingPaidSubs7d, 0),
      endingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].endingPaidSubs7d, 0),
    };

    return {
      explanation: "Churn Rate = (Total Churn Count / Starting Paid Subscribers) × 100",
      note: "If churn rate seems too low, check if the 'churn' field is capturing all churned subscribers. The 'churn' field counts subscriptions that ended on each day.",
      platformBreakdown: breakdown,
      unified30Day: {
        ...unified30d,
        calculatedChurnRate: calculateChurnRate(unified30d.totalChurn, unified30d.startingSubs),
        subscriberDelta: unified30d.endingSubs - unified30d.startingSubs,
      },
      unified7Day: {
        ...unified7d,
        calculatedChurnRate: calculateChurnRate(unified7d.totalChurn, unified7d.startingSubs),
        subscriberDelta: unified7d.endingSubs - unified7d.startingSubs,
      },
      suggestion: "Compare 'subscriberDelta' (ending - starting) with 'totalChurn'. If delta is larger (more negative), there may be churned subscribers not captured in the 'churn' field.",
    };
  },
});
