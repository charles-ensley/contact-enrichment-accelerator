@IsTest
private class ContactEnrichmentRetentionJobTest {
    @IsTest
    static void testPurgeRemovesOnlyExpiredDismissed() {
        Account acc = new Account(Name = 'Retention Test Corp');
        insert acc;

        Contact con = new Contact(
            AccountId = acc.Id,
            FirstName = 'Grace',
            LastName = 'Holloway',
            Email = 'gholloway@example.com',
            Phone = '555-0400'
        );
        insert con;

        List<Contact_Enrichment_Suggestion__c> seed = new List<Contact_Enrichment_Suggestion__c>{
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Title',
                Field_Label__c = 'Title',
                Current_Value__c = 'VP',
                Suggested_Value__c = 'SVP',
                Source__c = 'Web_Search',
                Confidence__c = 80,
                Rationale__c = 'Old dismissed suggestion that should be purged.',
                Status__c = 'Dismissed',
                Category__c = 'Title_Change'
            ),
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Phone',
                Field_Label__c = 'Phone',
                Current_Value__c = '555-0400',
                Suggested_Value__c = '555-0401',
                Source__c = 'Web_Search',
                Confidence__c = 70,
                Rationale__c = 'Recently dismissed suggestion that should be retained.',
                Status__c = 'Dismissed',
                Category__c = 'Contact_Info'
            ),
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Department',
                Field_Label__c = 'Department',
                Current_Value__c = 'Ops',
                Suggested_Value__c = 'Digital',
                Source__c = 'LinkedIn',
                Confidence__c = 90,
                Rationale__c = 'Old accepted suggestion that must be retained as audit trail.',
                Status__c = 'Accepted',
                Category__c = 'Department_Change'
            )
        };
        insert seed;

        // Reviewed_Date__c drives the retention window; set after insert to control the values.
        seed[0].Reviewed_Date__c = Datetime.now().addDays(-120);
        seed[1].Reviewed_Date__c = Datetime.now().addDays(-10);
        seed[2].Reviewed_Date__c = Datetime.now().addDays(-200);
        update seed;

        Test.startTest();
        Integer removed = ContactEnrichmentRetentionJob.purgeExpiredDismissed();
        Test.stopTest();

        System.assertEquals(1, removed, 'Only the expired dismissed suggestion should be purged');

        Set<Id> surviving = new Map<Id, Contact_Enrichment_Suggestion__c>(
            [SELECT Id FROM Contact_Enrichment_Suggestion__c WHERE Contact__c = :con.Id]
        ).keySet();
        System.assertEquals(2, surviving.size(), 'Recent dismissed and accepted records must remain');
        System.assert(!surviving.contains(seed[0].Id), 'Expired dismissed record should be gone');
        System.assert(surviving.contains(seed[1].Id), 'Recent dismissed record should remain');
        System.assert(surviving.contains(seed[2].Id), 'Accepted record should remain');
    }

    @IsTest
    static void testScheduleAndNoOpWhenNothingExpired() {
        Account acc = new Account(Name = 'Retention Empty Corp');
        insert acc;

        Test.startTest();
        Integer removed = ContactEnrichmentRetentionJob.purgeExpiredDismissed();
        String jobId = System.schedule(
            'Contact Enrichment Retention Test',
            '0 0 2 * * ?',
            new ContactEnrichmentRetentionJob()
        );
        Test.stopTest();

        System.assertEquals(0, removed, 'Nothing to purge should return zero');
        System.assertNotEquals(null, jobId, 'Job should schedule successfully');
    }
}
