import { LightningElement, api, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import { getRecord, getFieldValue, notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import hasAdminPermission from '@salesforce/customPermission/Contact_Enrichment_Admin';
import LAST_CHECK_FIELD from '@salesforce/schema/Contact.Last_Enrichment_Check__c';
import getSuggestions from '@salesforce/apex/ContactEnrichmentController.getSuggestions';
import acceptSuggestion from '@salesforce/apex/ContactEnrichmentController.acceptSuggestion';
import dismissSuggestion from '@salesforce/apex/ContactEnrichmentController.dismissSuggestion';
import acceptAllSuggestions from '@salesforce/apex/ContactEnrichmentController.acceptAllSuggestions';

const SOURCE_LABELS = {
    ZoomInfo: 'ZoomInfo',
    LinkedIn: 'LinkedIn',
    Web_Search: 'Web Search',
    Company_Website: 'Company Website',
    News: 'News',
    Internal_Analysis: 'Internal Analysis'
};

const SOURCE_ICONS = {
    ZoomInfo: 'utility:company',
    LinkedIn: 'utility:socialshare',
    Web_Search: 'utility:search',
    Company_Website: 'utility:world',
    News: 'utility:news',
    Internal_Analysis: 'utility:einstein'
};

const CATEGORY_LABELS = {
    Title_Change: 'Title Change',
    Status_Change: 'Status Change',
    Department_Change: 'Dept Change',
    Contact_Info: 'Contact Info',
    Role_Change: 'Role Change',
    Company_Change: 'Company Change',
    Other: 'Other'
};

const DISMISS_REASON_OPTIONS = [
    { label: 'Already correct in {{crmName}}', value: 'Already Correct' },
    { label: 'Suggestion is inaccurate', value: 'Suggestion Inaccurate' },
    { label: 'Wrong contact / mismatched record', value: 'Wrong Contact' },
    { label: 'External source is outdated', value: 'Source Outdated' },
    { label: 'Duplicate contact', value: 'Duplicate Contact' },
    { label: 'No longer relevant (inactive / left)', value: 'No Longer Relevant' },
    { label: 'Will verify manually', value: 'Will Verify Manually' },
    { label: 'Other', value: 'Other' }
];

const ENRICHMENT_FLOW_NAME = 'Generate_Contact_Enrichment_Suggestions';

export default class ContactEnrichmentWidget extends LightningElement {
    @api recordId;
    suggestions = [];
    error;
    isLoading = true;
    isProcessing = false;
    showHistory = false;
    showFlow = false;
    wiredResult;
    activeDismissId;
    dismissReason = '';
    dismissReasonDetail = '';
    lastCheckDate;
    recordLoaded = false;
    expandedRationale = {};

    dismissReasonOptions = DISMISS_REASON_OPTIONS;
    flowApiName = ENRICHMENT_FLOW_NAME;

    get flowInputVariables() {
        return [{ name: 'recordId', type: 'String', value: this.recordId }];
    }

    @wire(getSuggestions, { contactId: '$recordId' })
    wiredSuggestions(result) {
        this.wiredResult = result;
        this.isLoading = false;
        if (result.data) {
            this.suggestions = result.data.map((s) => ({
                ...s,
                sourceLabel: SOURCE_LABELS[s.Source__c] || s.Source__c,
                sourceIcon: SOURCE_ICONS[s.Source__c] || 'utility:database',
                categoryLabel: CATEGORY_LABELS[s.Category__c] || s.Category__c,
                confidenceIcon: this.getConfidenceIcon(s.Confidence__c),
                confidenceClass: this.getConfidenceClass(s.Confidence__c),
                hasRationale: !!s.Rationale__c,
                statusIcon: s.Status__c === 'Accepted' ? 'utility:check' : 'utility:close',
                statusBadgeClass:
                    s.Status__c === 'Accepted'
                        ? 'slds-badge badge-accepted'
                        : 'slds-badge badge-dismissed',
                reviewerName: s.Reviewed_By__r ? s.Reviewed_By__r.Name : null,
                dismissReasonLabel: this.getDismissReasonLabel(s.Dismiss_Reason__c),
                hasDismissReason:
                    s.Status__c === 'Dismissed' &&
                    (!!s.Dismiss_Reason__c || !!s.Dismiss_Reason_Detail__c)
            }));
            this.error = undefined;
        } else if (result.error) {
            this.error = result.error;
            this.suggestions = [];
        }
    }

    @wire(getRecord, { recordId: '$recordId', fields: [LAST_CHECK_FIELD] })
    wiredContact(result) {
        this.recordLoaded = true;
        if (result.data) {
            this.lastCheckDate = getFieldValue(result.data, LAST_CHECK_FIELD);
        }
    }

    get hasRunCheck() {
        return !!this.lastCheckDate;
    }

    get lastCheckTimestamp() {
        // lightning-relative-date-time needs a numeric timestamp (or Date);
        // getFieldValue returns an ISO string, which renders as "Invalid date".
        if (!this.lastCheckDate) {
            return null;
        }
        const ms = new Date(this.lastCheckDate).getTime();
        return Number.isNaN(ms) ? null : ms;
    }

    get pendingSuggestions() {
        return this.suggestions
            .filter((s) => s.Status__c === 'Pending')
            .map((s) => {
                const expanded = !!this.expandedRationale[s.Id];
                return {
                    ...s,
                    showDismissPanel: s.Id === this.activeDismissId,
                    showRationale: expanded,
                    rationaleToggleLabel: expanded ? 'Hide Rationale' : 'See Rationale',
                    rationaleToggleIcon: expanded ? 'utility:chevrondown' : 'utility:chevronright'
                };
            });
    }

    get isOtherReason() {
        return this.dismissReason === 'Other';
    }

    get confirmDismissDisabled() {
        if (this.isProcessing || !this.dismissReason) {
            return true;
        }
        if (this.isOtherReason && !this.dismissReasonDetail.trim()) {
            return true;
        }
        return false;
    }

    get reviewedSuggestions() {
        return this.suggestions.filter((s) => s.Status__c !== 'Pending');
    }

    get hasPending() {
        return !this.isLoading && this.pendingSuggestions.length > 0;
    }

    get showBody() {
        // Hide the suggestion list/empty state while the enrichment flow runs inline.
        return !this.showFlow;
    }

    get actionsDisabled() {
        // Prevent relaunching the check (or bulk actions) while a run is in progress.
        return this.isProcessing || this.showFlow;
    }

    get isAdmin() {
        return hasAdminPermission === true;
    }

    get hasReviewedSuggestions() {
        // Cross-suggestion history is gated to admins/data stewards; reps see only open items.
        return this.isAdmin && !this.isLoading && this.reviewedSuggestions.length > 0;
    }

    get pendingCount() {
        return this.pendingSuggestions.length;
    }

    get pendingBadge() {
        return `${this.pendingCount} pending`;
    }

    get reviewedCount() {
        return this.reviewedSuggestions.length;
    }

    get showEmptyState() {
        return (
            !this.isLoading &&
            this.recordLoaded &&
            !this.hasPending &&
            !this.hasReviewedSuggestions &&
            !this.error
        );
    }

    get showNeedsCheckState() {
        // No check has ever run for this contact - prompt the user to run one.
        return this.showEmptyState && !this.hasRunCheck;
    }

    get showUpToDateState() {
        // A check has run and produced no open suggestions - genuinely up to date.
        return this.showEmptyState && this.hasRunCheck;
    }

    get historyIcon() {
        return this.showHistory ? 'utility:chevrondown' : 'utility:chevronright';
    }

    get historyLabel() {
        return this.showHistory ? 'Hide History' : 'Show History';
    }

    getConfidenceIcon(confidence) {
        if (confidence >= 90) return 'utility:success';
        if (confidence >= 70) return 'utility:info';
        return 'utility:warning';
    }

    getConfidenceClass(confidence) {
        // 90+ green, 76-89 yellow, 75 and below orange.
        if (confidence >= 90) return 'confidence-pill slds-m-left_xx-small confidence-green';
        if (confidence >= 76) return 'confidence-pill slds-m-left_xx-small confidence-yellow';
        return 'confidence-pill slds-m-left_xx-small confidence-orange';
    }

    toggleRationale(event) {
        const id = event.currentTarget.dataset.id;
        this.expandedRationale = { ...this.expandedRationale, [id]: !this.expandedRationale[id] };
    }

    getDismissReasonLabel(value) {
        if (!value) {
            return null;
        }
        const match = DISMISS_REASON_OPTIONS.find((o) => o.value === value);
        return match ? match.label : value;
    }

    toggleHistory() {
        this.showHistory = !this.showHistory;
    }

    async handleAccept(event) {
        const suggestionId = event.currentTarget.dataset.id;
        this.isProcessing = true;
        try {
            await acceptSuggestion({ suggestionId });
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Suggestion Accepted',
                    message: 'Contact field updated successfully.',
                    variant: 'success'
                })
            );
            await refreshApex(this.wiredResult);
        } catch (err) {
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Error',
                    message: err.body?.message || 'Failed to accept suggestion.',
                    variant: 'error'
                })
            );
        } finally {
            this.isProcessing = false;
        }
    }

    handleDismiss(event) {
        this.activeDismissId = event.currentTarget.dataset.id;
        this.dismissReason = '';
        this.dismissReasonDetail = '';
    }

    handleCancelDismiss() {
        this.activeDismissId = undefined;
        this.dismissReason = '';
        this.dismissReasonDetail = '';
    }

    handleReasonChange(event) {
        this.dismissReason = event.detail.value;
        if (!this.isOtherReason) {
            this.dismissReasonDetail = '';
        }
    }

    handleReasonDetailChange(event) {
        this.dismissReasonDetail = event.detail.value;
    }

    async handleConfirmDismiss(event) {
        const suggestionId = event.currentTarget.dataset.id;
        const reason = this.dismissReason;
        const reasonDetail = this.dismissReasonDetail;
        this.isProcessing = true;
        try {
            await dismissSuggestion({ suggestionId, reason, reasonDetail });
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Suggestion Dismissed',
                    message: 'Suggestion has been dismissed.',
                    variant: 'info'
                })
            );
            this.handleCancelDismiss();
            await refreshApex(this.wiredResult);
        } catch (err) {
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Error',
                    message: err.body?.message || 'Failed to dismiss suggestion.',
                    variant: 'error'
                })
            );
        } finally {
            this.isProcessing = false;
        }
    }

    async handleAcceptAll() {
        this.isProcessing = true;
        try {
            const result = await acceptAllSuggestions({ contactId: this.recordId });
            const accepted = result?.acceptedCount ?? 0;
            const failed = result?.failedCount ?? 0;
            if (failed > 0) {
                const detail = result?.failures?.length ? ` ${result.failures.join(' | ')}` : '';
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: accepted > 0 ? 'Some Suggestions Applied' : 'No Suggestions Applied',
                        message: `${accepted} field(s) updated, ${failed} could not be applied.${detail}`,
                        variant: accepted > 0 ? 'warning' : 'error',
                        mode: 'sticky'
                    })
                );
            } else {
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: 'All Suggestions Accepted',
                        message: `${accepted} contact field(s) updated.`,
                        variant: 'success'
                    })
                );
            }
            await refreshApex(this.wiredResult);
        } catch (err) {
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Error',
                    message: err.body?.message || 'Failed to accept all suggestions.',
                    variant: 'error'
                })
            );
        } finally {
            this.isProcessing = false;
        }
    }

    handleRunCheck() {
        this.showFlow = true;
    }

    handleCloseFlow() {
        this.showFlow = false;
    }

    handleFlowStatusChange(event) {
        const status = event.detail.status;
        if (status === 'FINISHED' || status === 'FINISHED_SCREEN') {
            this.showFlow = false;
            this.handleRefresh();
            // The flow stamps Last_Enrichment_Check__c server-side; refresh LDS so the
            // "Last checked" bar reflects the new run immediately.
            notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
        }
    }

    handleRefresh() {
        this.isLoading = true;
        refreshApex(this.wiredResult).then(() => {
            this.isLoading = false;
        });
    }
}
