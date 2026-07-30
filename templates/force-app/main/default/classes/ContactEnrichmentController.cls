public with sharing class ContactEnrichmentController {
    // Field types whose values can be safely written from a text suggested value.
    private static final Set<Schema.DisplayType> TEXT_LIKE_TYPES = new Set<Schema.DisplayType>{
        Schema.DisplayType.STRING,
        Schema.DisplayType.TEXTAREA,
        Schema.DisplayType.PICKLIST,
        Schema.DisplayType.COMBOBOX,
        Schema.DisplayType.URL,
        Schema.DisplayType.EMAIL,
        Schema.DisplayType.PHONE,
        Schema.DisplayType.ENCRYPTEDSTRING
    };

    @AuraEnabled(cacheable=true)
    public static List<Contact_Enrichment_Suggestion__c> getSuggestions(Id contactId) {
        return [
            SELECT
                Id,
                Name,
                Field_API_Name__c,
                Field_Label__c,
                Current_Value__c,
                Suggested_Value__c,
                Source__c,
                Confidence__c,
                Rationale__c,
                Status__c,
                Category__c,
                Reviewed_Date__c,
                Reviewed_By__c,
                Reviewed_By__r.Name,
                Dismiss_Reason__c,
                Dismiss_Reason_Detail__c,
                CreatedDate
            FROM Contact_Enrichment_Suggestion__c
            WHERE Contact__c = :contactId
            ORDER BY Status__c ASC, Confidence__c DESC, CreatedDate DESC
            LIMIT 50
        ];
    }

    @AuraEnabled
    public static Contact_Enrichment_Suggestion__c acceptSuggestion(Id suggestionId) {
        List<Contact_Enrichment_Suggestion__c> suggestions = [
            SELECT Id, Contact__c, Field_API_Name__c, Field_Label__c, Suggested_Value__c, Status__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Id = :suggestionId
            LIMIT 1
        ];
        if (suggestions.isEmpty()) {
            throw new AuraHandledException('Suggestion record was not found.');
        }
        Contact_Enrichment_Suggestion__c suggestion = suggestions[0];

        if (suggestion.Status__c != 'Pending') {
            throw new AuraHandledException('This suggestion has already been reviewed.');
        }

        if (suggestion.Contact__c == null) {
            throw new AuraHandledException('This suggestion is not linked to a Contact.');
        }

        // Apply the change. Any failure (validation rule, restricted picklist, FLS) is
        // surfaced as a clear, user-facing message instead of failing silently.
        String failure = applyToContact(
            suggestion.Contact__c,
            suggestion.Field_API_Name__c,
            suggestion.Suggested_Value__c
        );
        if (failure != null) {
            throw new AuraHandledException(failure);
        }

        suggestion.Status__c = 'Accepted';
        suggestion.Reviewed_Date__c = Datetime.now();
        suggestion.Reviewed_By__c = UserInfo.getUserId();
        update suggestion;

        updatePendingCount(suggestion.Contact__c);

        return suggestion;
    }

    @AuraEnabled
    public static Contact_Enrichment_Suggestion__c dismissSuggestion(
        Id suggestionId,
        String reason,
        String reasonDetail
    ) {
        List<Contact_Enrichment_Suggestion__c> suggestions = [
            SELECT Id, Contact__c, Status__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Id = :suggestionId
            LIMIT 1
        ];
        if (suggestions.isEmpty()) {
            throw new AuraHandledException('Suggestion record was not found.');
        }
        Contact_Enrichment_Suggestion__c suggestion = suggestions[0];

        if (suggestion.Status__c != 'Pending') {
            throw new AuraHandledException('This suggestion has already been reviewed.');
        }

        suggestion.Status__c = 'Dismissed';
        suggestion.Dismiss_Reason__c = String.isBlank(reason) ? null : reason;
        suggestion.Dismiss_Reason_Detail__c = String.isBlank(reasonDetail) ? null : reasonDetail;
        suggestion.Reviewed_Date__c = Datetime.now();
        suggestion.Reviewed_By__c = UserInfo.getUserId();
        update suggestion;

        updatePendingCount(suggestion.Contact__c);

        return suggestion;
    }

    @AuraEnabled
    public static AcceptAllResult acceptAllSuggestions(Id contactId) {
        List<Contact> contacts = [SELECT Id FROM Contact WHERE Id = :contactId LIMIT 1];
        if (contacts.isEmpty()) {
            throw new AuraHandledException('Contact was not found.');
        }

        List<Contact_Enrichment_Suggestion__c> pending = [
            SELECT Id, Contact__c, Field_API_Name__c, Field_Label__c, Suggested_Value__c, Status__c
            FROM Contact_Enrichment_Suggestion__c
            WHERE Contact__c = :contactId AND Status__c = 'Pending'
            ORDER BY Confidence__c DESC
        ];

        if (pending.isEmpty()) {
            throw new AuraHandledException('No pending suggestions to accept.');
        }

        // Apply each suggestion independently so a single field that a validation rule
        // rejects does not block the others from being accepted.
        List<Contact_Enrichment_Suggestion__c> accepted = new List<Contact_Enrichment_Suggestion__c>();
        List<String> failures = new List<String>();
        Datetime now = Datetime.now();
        Id userId = UserInfo.getUserId();

        for (Contact_Enrichment_Suggestion__c s : pending) {
            String failure = applyToContact(s.Contact__c, s.Field_API_Name__c, s.Suggested_Value__c);
            if (failure == null) {
                s.Status__c = 'Accepted';
                s.Reviewed_Date__c = now;
                s.Reviewed_By__c = userId;
                accepted.add(s);
            } else {
                String label = String.isBlank(s.Field_Label__c) ? s.Field_API_Name__c : s.Field_Label__c;
                failures.add(label + ': ' + failure);
            }
        }

        if (!accepted.isEmpty()) {
            update accepted;
        }
        updatePendingCount(contactId);

        AcceptAllResult result = new AcceptAllResult();
        result.acceptedCount = accepted.size();
        result.failedCount = failures.size();
        result.failures = failures;
        return result;
    }

    @AuraEnabled(cacheable=true)
    public static List<EnrichmentSummary> getEnrichmentSummary(Id accountId) {
        List<EnrichmentSummary> summaries = new List<EnrichmentSummary>();

        List<AggregateResult> results = [
            SELECT Contact__r.Id contactId, Contact__r.Name contactName, Status__c status, COUNT(Id) cnt
            FROM Contact_Enrichment_Suggestion__c
            WHERE Contact__r.AccountId = :accountId
            GROUP BY Contact__r.Id, Contact__r.Name, Status__c
            ORDER BY Contact__r.Name
        ];

        Map<Id, EnrichmentSummary> summaryMap = new Map<Id, EnrichmentSummary>();
        for (AggregateResult ar : results) {
            Id conId = (Id) ar.get('contactId');
            if (!summaryMap.containsKey(conId)) {
                EnrichmentSummary es = new EnrichmentSummary();
                es.contactId = conId;
                es.contactName = (String) ar.get('contactName');
                es.pendingCount = 0;
                es.acceptedCount = 0;
                es.dismissedCount = 0;
                summaryMap.put(conId, es);
            }
            EnrichmentSummary es = summaryMap.get(conId);
            String status = (String) ar.get('status');
            Integer cnt = (Integer) ar.get('cnt');
            if (status == 'Pending') {
                es.pendingCount = cnt;
            } else if (status == 'Accepted') {
                es.acceptedCount = cnt;
            } else if (status == 'Dismissed') {
                es.dismissedCount = cnt;
            }
        }

        summaries.addAll(summaryMap.values());
        return summaries;
    }

    /**
     * Writes a suggested value onto a Contact field with full safety checks.
     * Returns null on success, or a human-readable error message on failure
     * (unknown/unwritable field, unsupported type, invalid restricted-picklist
     * value, or a DML/validation-rule rejection). Never throws.
     */
    private static String applyToContact(Id contactId, String fieldApiName, String suggestedValue) {
        if (contactId == null) {
            return 'This suggestion is not linked to a Contact.';
        }
        if (String.isBlank(fieldApiName)) {
            return 'No field was specified for this suggestion.';
        }

        Schema.SObjectField token = Schema.SObjectType.Contact.fields.getMap().get(fieldApiName);
        if (token == null) {
            return 'Field "' + fieldApiName + '" does not exist on Contact.';
        }

        Schema.DescribeFieldResult dfr = token.getDescribe();
        if (!dfr.isUpdateable()) {
            return 'You do not have permission to update "' + dfr.getLabel() + '".';
        }
        if (!TEXT_LIKE_TYPES.contains(dfr.getType())) {
            return 'Automated accept supports text-based fields only; please update "' + dfr.getLabel() + '" manually.';
        }

        String valueToWrite = suggestedValue;

        // For restricted picklists, canonicalize casing to an active value and reject unknown values
        // up front so we return a clear message rather than a cryptic platform error.
        if (dfr.getType() == Schema.DisplayType.PICKLIST && dfr.isRestrictedPicklist() && String.isNotBlank(suggestedValue)) {
            String matched;
            for (Schema.PicklistEntry entry : dfr.getPicklistValues()) {
                if (entry.isActive() && entry.getValue().equalsIgnoreCase(suggestedValue)) {
                    matched = entry.getValue();
                    break;
                }
            }
            if (matched == null) {
                return '"' + suggestedValue + '" is not a valid value for "' + dfr.getLabel() + '".';
            }
            valueToWrite = matched;
        }

        Contact toUpdate = new Contact(Id = contactId);
        toUpdate.put(fieldApiName, valueToWrite);

        Database.SaveResult sr = Database.update(toUpdate, false);
        if (!sr.isSuccess()) {
            List<String> messages = new List<String>();
            for (Database.Error err : sr.getErrors()) {
                messages.add(err.getMessage());
            }
            return String.join(messages, ' ');
        }
        return null;
    }

    private static void updatePendingCount(Id contactId) {
        if (contactId == null) {
            return;
        }

        Integer pendingCount = [
            SELECT COUNT()
            FROM Contact_Enrichment_Suggestion__c
            WHERE Contact__c = :contactId AND Status__c = 'Pending'
        ];
        Contact con = new Contact(Id = contactId, Pending_Enrichment_Count__c = pendingCount);
        update con;
    }

    public class AcceptAllResult {
        @AuraEnabled
        public Integer acceptedCount;
        @AuraEnabled
        public Integer failedCount;
        @AuraEnabled
        public List<String> failures;
    }

    public class EnrichmentSummary {
        @AuraEnabled
        public Id contactId;
        @AuraEnabled
        public String contactName;
        @AuraEnabled
        public Integer pendingCount;
        @AuraEnabled
        public Integer acceptedCount;
        @AuraEnabled
        public Integer dismissedCount;
    }
}
