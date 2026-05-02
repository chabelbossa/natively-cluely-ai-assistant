export interface UserProfessionalProfile {
  /** User's current professional role/title */
  role?: string;
  /** Current company/organization */
  company?: string;
  /** Experience level */
  seniority?: 'junior' | 'mid' | 'senior' | 'lead' | 'staff' | 'principal';
  /** Primary technology stack */
  mainStack?: string[];
  /** Current active projects */
  currentProjects?: string[];
  /** Typical meeting context (e.g. "standups with manager", "client calls") */
  meetingContext?: string;
  /** Target role for job search / interview prep */
  interviewTargetRole?: string;
  /** Full job description text for the target role */
  jobDescription?: string;
  /** Preferred suggestion style */
  preferredSuggestionStyle?: 'concise' | 'strategic' | 'technical' | 'beginner_friendly';
}

export interface ProfileData {
  identity?: {
    name?: string;
    email?: string;
  };
  experienceCount?: number;
  projectCount?: number;
  nodeCount?: number;
  skills?: string[];
  hasActiveJD?: boolean;
  activeJD?: {
    title?: string;
    company?: string;
    level?: string;
    technologies?: string[];
  };
  negotiationScript?: unknown;
  professionalProfile?: UserProfessionalProfile;
}
