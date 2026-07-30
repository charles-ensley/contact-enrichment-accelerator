@IsTest
private class ContactEnrichmentControllerTest {
    @TestSetup
    static void setupData() {
        Account acc = new Account(Name = 'Test Corp');
        insert acc;

        Contact con = new Contact(
            AccountId = acc.Id,
            FirstName = 'Jane',
            LastName = 'Doe',
            Title = 'VP Operations',
            Department = 'Operations',
            Email = 'jdoe@example.com',
            Phone = '555-0100',
            Pending_Enrichment_Count__c = 2
        );
        insert con;

        List<Contact_Enrichment_Suggestion__c> suggestions = new List<Contact_Enrichment_Suggestion__c>{
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Title',
                Field_Label__c = 'Title',
                Current_Value__c = 'VP Operations',
                Suggested_Value__c = 'SVP Operations',
                Source__c = 'Web_Search',
                Confidence__c = 92,
                Rationale__c = 'Web result shows a promotion to SVP Operations.',
                Status__c = 'Pending',
                Category__c = 'Title_Change'
            ),
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Phone',
                Field_Label__c = 'Phone',
                Current_Value__c = '555-0100',
                Suggested_Value__c = '555-0199',
                Source__c = 'LinkedIn',
                Confidence__c = 75,
                Rationale__c = 'LinkedIn profile lists updated phone number.',
                Status__c = 'Pending',
                Category__c = 'Contact_Info'
            ),
            new Contact_Enrichment_Suggestion__c(
                Contact__c = con.Id,
                Field_API_Name__c = 'Department',
                Field_Label__c = 'Department',
                Current_Value__c = 'Operations',
                Suggested_Value__c = 'Digital Strategy',
                Source__c = 'LinkedIn',
                Confidence__c = 80,
                Rationale__c = 'LinkedIn headline changed to Digital Strategy team.',
                Status__c = 'Accepted',
                Category__c = 'Department_Change',
                Reviewed_Date__c = Datetime.now().addDays(-5),
                Reviewed_By__c = UserInfo.getUserId()
            )
        };
        insert suggestions;
    }

    @IsTest
    static void testGetSuggestions() {
        Contact con = [SELECT Id FROM Contact WHERE LastName = 'Doe' LIMIT 1];

        Test.startTest();
        List<Contact_Enrichment_Suggestion__c> results = ContactEnrichmentController.getSuggestions(con.Id);
        Test.stopTest();

        System.assertEquals(3, results.size(), 'Should return all suggestions');
        System.assertEquals('Pending', results[0].Status__c, 'Pending sort first');
    }

    @IsTest
    static void testAcceptSuggestion() {
        Contact_Enrichment_Suggestion__c titleSugg = [
            SELECT Id, Contact__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Field_API_Name__c = 'Title' AND Status__c = 'Pending'
            LIMIT 1
        ];

        Test.startTest();
        Contact_Enrichment_Suggestion__c result = ContactEnrichmentController.acceptSuggestion(titleSugg.Id);
        Test.stopTest();

        System.assertEquals('Accepted', result.Status__c);
        System.assertNotEquals(null, result.Reviewed_Date__c);

        Contact updated = [SELECT Title, Pending_Enrichment_Count__c FROM Contact WHERE Id = :titleSugg.Contact__c];
        System.assertEquals('SVP Operations', updated.Title);
        System.assertEquals(1, updated.Pending_Enrichment_Count__c, 'Count should decrement');
    }

    @IsTest
    static void testAcceptSuggestionAlreadyReviewed() {
        Contact_Enrichment_Suggestion__c accepted = [
            SELECT Id
            FROM Contact_Enrichment_Suggestion__c
            WHERE Status__c = 'Accepted'
            LIMIT 1
        ];

        Test.startTest();
        try {
            ContactEnrichmentController.acceptSuggestion(accepted.Id);
            System.assert(false, 'Should have thrown');
        } catch (AuraHandledException e) {
            System.assertNotEquals(null, e.getMessage(), 'Expected handled exception');
        }
        Test.stopTest();
    }

    @IsTest
    static void testDismissSuggestion() {
        Contact_Enrichment_Suggestion__c phoneSugg = [
            SELECT Id, Contact__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Field_API_Name__c = 'Phone' AND Status__c = 'Pending'
            LIMIT 1
        ];

        Test.startTest();
        Contact_Enrichment_Suggestion__c result = ContactEnrichmentController.dismissSuggestion(
            phoneSugg.Id,
            'Suggestion Inaccurate',
            null
        );
        Test.stopTest();

        System.assertEquals('Dismissed', result.Status__c);
        System.assertNotEquals(null, result.Reviewed_Date__c);

        Contact_Enrichment_Suggestion__c reloaded = [
            SELECT Dismiss_Reason__c, Dismiss_Reason_Detail__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Id = :phoneSugg.Id
        ];
        System.assertEquals('Suggestion Inaccurate', reloaded.Dismiss_Reason__c, 'Reason should persist');
        System.assertEquals(null, reloaded.Dismiss_Reason_Detail__c, 'No detail expected');

        Contact updated = [SELECT Pending_Enrichment_Count__c FROM Contact WHERE Id = :phoneSugg.Contact__c];
        System.assertEquals(1, updated.Pending_Enrichment_Count__c, 'Count should decrement');
    }

    @IsTest
    static void testDismissSuggestionWithOtherReasonDetail() {
        Contact_Enrichment_Suggestion__c titleSugg = [
            SELECT Id, Contact__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Field_API_Name__c = 'Title' AND Status__c = 'Pending'
            LIMIT 1
        ];

        Test.startTest();
        Contact_Enrichment_Suggestion__c result = ContactEnrichmentController.dismissSuggestion(
            titleSugg.Id,
            'Other',
            'Contact confirmed still in role via phone call.'
        );
        Test.stopTest();

        System.assertEquals('Dismissed', result.Status__c);

        Contact_Enrichment_Suggestion__c reloaded = [
            SELECT Dismiss_Reason__c, Dismiss_Reason_Detail__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Id = :titleSugg.Id
        ];
        System.assertEquals('Other', reloaded.Dismiss_Reason__c, 'Reason should persist');
        System.assertEquals(
            'Contact confirmed still in role via phone call.',
            reloaded.Dismiss_Reason_Detail__c,
            'Detail should persist for Other'
        );
    }

    @IsTest
    static void testDismissSuggestionAlreadyReviewed() {
        Contact_Enrichment_Suggestion__c accepted = [
            SELECT Id
            FROM Contact_Enrichment_Suggestion__c
            WHERE Status__c = 'Accepted'
            LIMIT 1
        ];

        Test.startTest();
        try {
            ContactEnrichmentController.dismissSuggestion(accepted.Id, 'Already Correct', null);
            System.assert(false, 'Should have thrown');
        } catch (AuraHandledException e) {
            System.assertNotEquals(null, e.getMessage(), 'Expected handled exception');
        }
        Test.stopTest();
    }

    @IsTest
    static void testAcceptAllSuggestions() {
        Contact con = [SELECT Id FROM Contact WHERE LastName = 'Doe' LIMIT 1];

        Test.startTest();
        ContactEnrichmentController.acceptAllSuggestions(con.Id);
        Test.stopTest();

        List<Contact_Enrichment_Suggestion__c> remaining = [
            SELECT Id
            FROM Contact_Enrichment_Suggestion__c
            WHERE Contact__c = :con.Id AND Status__c = 'Pending'
        ];
        System.assertEquals(0, remaining.size(), 'No pending suggestions should remain');

        Contact updated = [SELECT Title, Phone, Pending_Enrichment_Count__c FROM Contact WHERE Id = :con.Id];
        System.assertEquals('SVP Operations', updated.Title);
        System.assertEquals('555-0199', updated.Phone);
        System.assertEquals(0, updated.Pending_Enrichment_Count__c);
    }

    @IsTest
    static void testAcceptAllNoPending() {
        Account acc = [SELECT Id FROM Account LIMIT 1];
        Contact con2 = new Contact(
            AccountId = acc.Id,
            FirstName = 'No',
            LastName = 'Suggestions',
            Email = 'nosuggestions@example.com',
            Phone = '555-0188',
            Pending_Enrichment_Count__c = 0
        );
        insert con2;

        Test.startTest();
        try {
            ContactEnrichmentController.acceptAllSuggestions(con2.Id);
            System.assert(false, 'Should have thrown');
        } catch (AuraHandledException e) {
            System.assertNotEquals(null, e.getMessage(), 'Expected handled exception');
        }
        Test.stopTest();
    }

    @IsTest
    static void testGetEnrichmentSummary() {
        Account acc = [SELECT Id FROM Account LIMIT 1];

        Test.startTest();
        List<ContactEnrichmentController.EnrichmentSummary> summaries = ContactEnrichmentController.getEnrichmentSummary(
            acc.Id
        );
        Test.stopTest();

        System.assertEquals(1, summaries.size(), 'One contact with suggestions');
        ContactEnrichmentController.EnrichmentSummary s = summaries[0];
        System.assertEquals(2, s.pendingCount);
        System.assertEquals(1, s.acceptedCount);
        System.assertEquals(0, s.dismissedCount);
    }

    @IsTest
    static void testAcceptSuggestionMissingContact() {
        Contact_Enrichment_Suggestion__c orphanSuggestion = new Contact_Enrichment_Suggestion__c(
            Field_API_Name__c = 'Title',
            Field_Label__c = 'Title',
            Current_Value__c = 'Old Title',
            Suggested_Value__c = 'New Title',
            Source__c = 'LinkedIn',
            Confidence__c = 80,
            Rationale__c = 'Simulated suggestion with missing related contact.',
            Status__c = 'Pending',
            Category__c = 'Title_Change'
        );
        insert orphanSuggestion;

        Test.startTest();
        try {
            ContactEnrichmentController.acceptSuggestion(orphanSuggestion.Id);
            System.assert(false, 'Should have thrown for missing Contact__c');
        } catch (AuraHandledException e) {
            System.assertNotEquals(null, e.getMessage(), 'Expected handled exception');
        }
        Test.stopTest();
    }

    @IsTest
    static void testAcceptUnknownFieldThrows() {
        Account acc = [SELECT Id FROM Account LIMIT 1];
        Contact c = new Contact(
            AccountId = acc.Id,
            FirstName = 'Sam',
            LastName = 'Ortiz',
            Email = 'sortiz@example.com',
            Phone = '555-0172',
            Pending_Enrichment_Count__c = 1
        );
        insert c;

        Contact_Enrichment_Suggestion__c s = new Contact_Enrichment_Suggestion__c(
            Contact__c = c.Id,
            Field_API_Name__c = 'Not_A_Real_Field__c',
            Field_Label__c = 'Bogus Field',
            Current_Value__c = 'x',
            Suggested_Value__c = 'y',
            Source__c = 'Web_Search',
            Confidence__c = 50,
            Rationale__c = 'Suggestion references a field that does not exist.',
            Status__c = 'Pending',
            Category__c = 'Other'
        );
        insert s;

        Test.startTest();
        try {
            ContactEnrichmentController.acceptSuggestion(s.Id);
            System.assert(false, 'Should throw for an unknown field');
        } catch (AuraHandledException e) {
            System.assertNotEquals(null, e.getMessage(), 'Expected a clear handled exception');
        }
        Test.stopTest();

        Contact_Enrichment_Suggestion__c reloaded = [
            SELECT Status__c FROM Contact_Enrichment_Suggestion__c WHERE Id = :s.Id
        ];
        System.assertEquals('Pending', reloaded.Status__c, 'A rejected suggestion must stay Pending, not silently fail');
    }

    @IsTest
    static void testAcceptAllPartialFailure() {
        Account acc = [SELECT Id FROM Account LIMIT 1];
        Contact c = new Contact(
            AccountId = acc.Id,
            FirstName = 'Dana',
            LastName = 'Frost',
            Email = 'dfrost@example.com',
            Phone = '555-0173',
            Pending_Enrichment_Count__c = 2
        );
        insert c;

        List<Contact_Enrichment_Suggestion__c> sl = new List<Contact_Enrichment_Suggestion__c>{
            new Contact_Enrichment_Suggestion__c(
                Contact__c = c.Id,
                Field_API_Name__c = 'Title',
                Field_Label__c = 'Title',
                Current_Value__c = 'VP, Fund Operations',
                Suggested_Value__c = 'SVP, Fund Operations',
                Source__c = 'Web_Search',
                Confidence__c = 88,
                Rationale__c = 'Web result shows a promotion to SVP.',
                Status__c = 'Pending',
                Category__c = 'Title_Change'
            ),
            new Contact_Enrichment_Suggestion__c(
                Contact__c = c.Id,
                Field_API_Name__c = 'Not_A_Real_Field__c',
                Field_Label__c = 'Bogus Field',
                Current_Value__c = 'x',
                Suggested_Value__c = 'y',
                Source__c = 'Web_Search',
                Confidence__c = 55,
                Rationale__c = 'References a field that does not exist and must fail.',
                Status__c = 'Pending',
                Category__c = 'Other'
            )
        };
        insert sl;

        Test.startTest();
        ContactEnrichmentController.AcceptAllResult r = ContactEnrichmentController.acceptAllSuggestions(c.Id);
        Test.stopTest();

        System.assertEquals(1, r.acceptedCount, 'The valid suggestion should be accepted');
        System.assertEquals(1, r.failedCount, 'The invalid suggestion should be reported as failed');

        Contact updated = [SELECT Title, Pending_Enrichment_Count__c FROM Contact WHERE Id = :c.Id];
        System.assertEquals('SVP, Fund Operations', updated.Title, 'Valid field written');
        System.assertEquals(1, updated.Pending_Enrichment_Count__c, 'The failed suggestion must remain pending');
    }
}
