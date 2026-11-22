import { CampaignWorkflow } from '@/components/campaigns/campaign-workflow';
export default function CampaignsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-5 py-7">
      <h1 className="font-[--font-display] text-3xl">Revision campaigns</h1>
      <p>
        Plan a whole-book change with cited evidence, predicted consequences and an approval for
        every prose edit.
      </p>
      <CampaignWorkflow />
    </main>
  );
}
