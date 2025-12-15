import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { CircularText } from "@/components/CircularText";
import { ArrowRight, BarChart3, TrendingUp, Zap, Users, DollarSign, TrendingDown, RefreshCw, Shield, Clock, LucideIcon } from "lucide-react";

export default function Home() {
  const FeatureCard = ({ headline, description }: {
    headline: string;
    description: string;
  }) => (
    <div className="rounded-lg px-6 py-4 flex items-center gap-6">
      <div>
        <span className="text-xl font-medium text-gray-900">{headline}.</span>
        <span className="text-xl font-medium text-gray-500 ml-1">
          {description}
        </span>
      </div>
    </div>
  );

  const PlatformCard = ({ imageSrc, title, description, details, imageSize = 56 }: {
    imageSrc: string;
    title: string;
    description: string;
    details: string;
    imageSize?: number;
  }) => (
    <div className="rounded-xl p-8 border-2 border-gray-700 text-center">
      <div className="w-14 h-14 rounded-xl mb-4 flex items-center justify-center mx-auto">
        <Image
          src={imageSrc}
          alt={title}
          width={imageSize}
          height={imageSize}
        />
      </div>
      <div className="text-3xl font-semibold mb-2 text-gray-900">{title}</div>
      <p className="text-gray-600 text-xl mb-2">
        {description}
      </p>
      <div className="text-base text-gray-500">
        {details}
      </div>
    </div>
  );

  const BenefitCard = ({ iconBg, Icon, iconColor, title, description }: {
    iconBg: string;
    Icon: LucideIcon;
    iconColor: string;
    title: string;
    description: string;
  }) => (
    <div className="text-center">
      <div className={`w-12 h-12 rounded-full ${iconBg} flex items-center justify-center mx-auto mb-4`}>
        <Icon className={`w-6 h-6 ${iconColor}`} />
      </div>
      <div className="text-lg font-semibold mb-2 text-gray-900">{title}.</div>
      <p className="text-gray-600 text-sm">{description}</p>
    </div>
  );

  const MetricItem = ({ Icon, title, description }: {
    Icon: LucideIcon;
    title: string;
    description: string;
  }) => (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <Icon className="w-5 h-5 text-gray-500" />
        <div className="text-lg font-semibold text-gray-900">{title}</div>
      </div>
      <p className="text-gray-600 text-sm ml-8">{description}</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4 flex items-center justify-between">
          <Link href="/" className="text-3xl font-semibold">
            Metry
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/sign-in">
              <Button variant="outline" size="lg" className="text-gray-600 rounded-full">
                Sign In
              </Button>
            </Link>
            <Link href="/sign-up">
              <Button size="lg" variant="color" className="bg-violet-200 rounded-full">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-4 md:px-8 py-32 md:py-40 min-h-screen flex items-center justify-center">
        <div className="text-center max-w-4xl mx-auto">
          <div className="flex justify-center mb-36 relative mx-auto items-center justify-center">
            <div className="absolute">
              <CircularText
                text="ANALYTICS • METRICS • REVENUE • TRACKING • "
                spinDuration={8}
                className=""
                radius={152}
              />
            </div>
            <video
              autoPlay
              loop
              muted
              playsInline
              className="w-[189px] h-[190px] object-cover bg-white relative z-10"
            >
              <source src="/images/logo.mp4" type="video/mp4" />
            </video>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-6 text-gray-900">
            Simple subscription analytics
          </h1>
          <p className="text-lg md:text-3xl font-medium text-gray-500 mb-12">
            Track metrics across App Store, Google Play, and Stripe in one dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/sign-up">
              <Button size="lg" variant="color" className="group rounded-full bg-violet-200 text-black
">
                Get Started
                <ArrowRight className="ml-2 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
            <Link href="/sign-in">
              <Button variant="outline" size="lg" className="text-gray-700 rounded-full">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Platforms Section */}
      {/* <section className="max-w-7xl mx-auto px-4 md:px-8 py-12">
        <h2 className="text-xl md:text-3xl font-medium text-center mb-14 text-gray-900">
          Connect. <span className="text-gray-500">Integrate with App Store, Google Play, and Stripe.</span>
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          <PlatformCard
            imageSrc="/images/appstore.webp"
            title="App Store"
            description="Full subscriber metrics and revenue tracking."
            details="Active subscribers, trials, MRR, revenue, cancellations, renewals"
          />
          <PlatformCard
            imageSrc="/images/googleplay.webp"
            title="Google Play"
            description="Full revenue tracking via GCS financial report exports."
            details="Gross and net revenue with historical data"
            imageSize={45}
          />
          <PlatformCard
            imageSrc="/images/stripe.webp"
            title="Stripe"
            description="Full subscriber metrics and revenue tracking."
            details="Subscribers, MRR, revenue, cancellations, renewals"
            imageSize={45}
          />
        </div>
      </section> */}

      {/* Features Section */}
      {/* <section className="max-w-7xl mx-auto px-4 md:px-8 py-12">
        <h2 className="text-xl md:text-3xl font-medium text-center mb-14 text-gray-900">
          The simplest all-in-one analytics
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <FeatureCard
            headline="Unified Metrics"
            description="Track subscribers, MRR, revenue, and churn across all platforms."
          />
          <FeatureCard
            headline="Historical Trends"
            description="View 52 weeks of historical data with per-platform breakdowns."
          />
          <FeatureCard
            headline="Automatic Sync"
            description="Daily automated syncs keep your metrics up to date."
          />
          <FeatureCard
            headline="Cross-Platform"
            description="Integrate App Store, Google Play, and Stripe in one dashboard."
          />
        </div>
      </section> */}

      {/* CTA Section */}
      {/* <section className="max-w-7xl mx-auto px-4 md:px-8 py-32 md:py-40">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-xl md:text-3xl font-medium mb-6 text-gray-900">
            Get started today
          </h2>
          <p className="text-xl md:text-3xl font-medium mb-14 text-gray-400">
            Connect your platforms and start tracking your subscription metrics.
          </p>
          <Link href="/sign-up">
            <Button size="lg" variant="color" className="bg-violet-200 group rounded-full py-5 px-12">
              Create Account
              <ArrowRight className="ml-2 group-hover:translate-x-1 transition-transform" />
            </Button>
          </Link>
        </div>
      </section> */}

      {/* Footer */}
      {/* <footer className="border-t border-gray-200 py-8">
        <div className="max-w-7xl mx-auto px-4 md:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="text-sm text-gray-600">
              © 2025 Metry
            </div>
            <div className="flex gap-6">
              <Link href="/sign-in" className="text-sm text-gray-600 hover:text-gray-900">
                Sign In
              </Link>
              <Link href="/sign-up" className="text-sm text-gray-600 hover:text-gray-900">
                Sign Up
              </Link>
            </div>
          </div>
        </div> 
      </footer>*/}
    </div>
  );
}

