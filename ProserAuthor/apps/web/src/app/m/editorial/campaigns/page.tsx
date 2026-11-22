import { CampaignWorkflow } from '@/components/campaigns/campaign-workflow';
export default function MobileCampaignsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-lg space-y-5 px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <h1 className="font-[--font-display] text-3xl">Revision campaigns</h1>
      <p>Follow a cited plan, one approved step at a time.</p>
      <CampaignWorkflow mobile />
    </main>
  );
}
