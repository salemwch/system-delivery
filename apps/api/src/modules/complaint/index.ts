/**
 * Complaint context public API (docs/02-domain-model.md §3.20).
 *
 * Deliberately narrow. Complaints are raised through the HTTP surface or, later,
 * by a consumer reacting to a failed delivery — no other module orchestrates
 * them, so only the module, the service and the vocabulary are exported.
 */
export { ComplaintModule } from "./complaint.module.js";
export { ComplaintService } from "./application/complaint.service.js";
export type {
  ComplaintActor,
  ComplaintDetail,
  ComplaintPage,
} from "./application/complaint.service.js";

export {
  COMPLAINT_TYPES,
  COMPLAINT_STATUSES,
  COMPLAINT_SEVERITIES,
  COMPLAINT_RAISERS,
  TERMINAL_COMPLAINT_STATUSES,
  DEFAULT_COMPLAINT_SLA_HOURS,
  canComplaintTransition,
  toComplaintStatus,
  toComplaintType,
  toComplaintSeverity,
} from "./domain/complaint-status.js";
export type {
  ComplaintType,
  ComplaintStatus,
  ComplaintSeverity,
  ComplaintRaiser,
} from "./domain/complaint-status.js";

export { formatComplaintCode } from "./domain/complaint-code.js";

export { complaints, complaintActivity, complaintSlaPolicies } from "./domain/schema.js";
export type { Complaint, NewComplaint, ComplaintActivityRow } from "./domain/schema.js";
