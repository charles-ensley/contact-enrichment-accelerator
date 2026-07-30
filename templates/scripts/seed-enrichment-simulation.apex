/*
 * OPTIONAL - Contact Enrichment: simulate a third-party enrichment source on a few contacts.
 *
 * If a paid provider (e.g. ZoomInfo) is NOT installed yet, the
 * Contact.Enrichment_Source_Data__c field can be used to SIMULATE what that
 * provider would return, letting you demo the extra source alongside the live
 * web search signal.
 *
 * The live web search signal does NOT need this - run this only if you want a
 * simulated provider-sourced suggestion to appear in the same demo.
 *
 * HOW TO USE:
 *   1. Replace the Ids below with real Contact Ids from your org.
 *   2. Adjust the simulated JSON so it conflicts with the current CRM values
 *      (e.g. a new title / status) - that conflict is what the AI surfaces.
 *   3. Run:  sf apex run -o <alias> -f scripts/seed-enrichment-simulation.apex
 *   4. To clean up later, set Enrichment_Source_Data__c back to null.
 */
Map<Id, String> simByContactId = new Map<Id, String>{
    '0030000000000000AAA' => JSON.serialize(new Map<String, Object>{
        'provider' => 'ZoomInfo',
        'lastUpdated' => String.valueOf(Date.today()),
        'title' => 'Managing Director',
        'company' => 'Example Corp',
        'status' => 'Active',
        'directPhone' => '212-555-0142'
    })
};

List<Contact> toUpdate = new List<Contact>();
for (Id cid : simByContactId.keySet()) {
    if (cid == '0030000000000000AAA') {
        continue; // skip the placeholder
    }
    toUpdate.add(new Contact(
        Id = cid,
        Enrichment_Source_Data__c = simByContactId.get(cid),
        Last_Enrichment_Check__c = null
    ));
}

if (toUpdate.isEmpty()) {
    System.debug('No real Contact Ids supplied - edit this script before running.');
} else {
    update toUpdate;
    System.debug('Simulated enrichment data applied to ' + toUpdate.size() + ' contact(s).');
}
