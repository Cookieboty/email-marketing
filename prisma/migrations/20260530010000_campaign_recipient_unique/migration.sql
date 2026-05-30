-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaignId_userId_key" ON "campaign_recipients"("campaignId", "userId");
