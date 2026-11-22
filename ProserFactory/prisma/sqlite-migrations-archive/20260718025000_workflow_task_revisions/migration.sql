ALTER TABLE "workflow_tasks" ADD COLUMN "input_revision_id" TEXT;
ALTER TABLE "workflow_tasks" ADD COLUMN "output_revision_id" TEXT;

CREATE INDEX "idx_workflow_task_input_revision"
ON "workflow_tasks"("input_revision_id");

CREATE INDEX "idx_workflow_task_output_revision"
ON "workflow_tasks"("output_revision_id");
