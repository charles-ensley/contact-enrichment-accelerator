/**
 * Scheduled data-retention job for the Contact Enrichment solution.
 *
 * Deletes DISMISSED suggestions older than the retention window so rejected AI
 * output is not retained indefinitely (GDPR data-minimization). ACCEPTED and
 * PENDING suggestions are always retained - accepted records form the audit
 * trail of applied changes.
 *
 * Schedule (e.g. daily at 2am) after deployment:
 *   System.schedule('Contact Enrichment Retention',
 *       '0 0 2 * * ?', new ContactEnrichmentRetentionJob());
 */
public with sharing class ContactEnrichmentRetentionJob implements Schedulable {
    @TestVisible
    private static Integer retentionDays = 90;

    public void execute(SchedulableContext sc) {
        purgeExpiredDismissed();
    }

    /**
     * Deletes dismissed suggestions whose review date is older than the retention
     * window and hard-empties them from the recycle bin. Returns the count removed.
     */
    public static Integer purgeExpiredDismissed() {
        Datetime cutoff = Datetime.now().addDays(-retentionDays);

        List<Contact_Enrichment_Suggestion__c> expired = [
            SELECT Id
            FROM Contact_Enrichment_Suggestion__c
            WHERE Status__c = 'Dismissed' AND Reviewed_Date__c != NULL AND Reviewed_Date__c < :cutoff
            LIMIT 10000
        ];

        if (expired.isEmpty()) {
            return 0;
        }

        Integer removed = 0;
        List<Database.DeleteResult> results = Database.delete(expired, false);
        List<SObject> hardDelete = new List<SObject>();
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                removed++;
                hardDelete.add(expired[i]);
            }
        }

        if (!hardDelete.isEmpty()) {
            // Hard-delete so purged records do not linger in the recycle bin (GDPR).
            Database.emptyRecycleBin(hardDelete);
        }

        return removed;
    }
}
