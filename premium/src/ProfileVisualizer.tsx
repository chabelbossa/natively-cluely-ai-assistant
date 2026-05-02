import React from 'react';
import {
  User,
  Building2,
  Briefcase,
  FileText,
  Layers,
  Code2,
  Target,
  FolderKanban,
  MessageSquareText,
  GraduationCap,
} from 'lucide-react';
import type { ProfileData } from '../../src/types/profile';

interface ProfileVisualizerProps {
  profileData: ProfileData | null;
}

const SENIORITY_LABELS: Record<string, string> = {
  junior: 'Junior',
  mid: 'Mid-level',
  senior: 'Senior',
  lead: 'Lead / Tech Lead',
  staff: 'Staff',
  principal: 'Principal',
};

const STYLE_LABELS: Record<string, string> = {
  concise: 'Concise',
  strategic: 'Strategic',
  technical: 'Technical',
  beginner_friendly: 'Beginner-Friendly',
};

export const ProfileVisualizer: React.FC<ProfileVisualizerProps> = ({ profileData }) => {
  if (!profileData) {
    return (
      <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 text-center">
        <User size={32} className="text-white/20 mx-auto mb-3" />
        <p className="text-sm text-white/40">
          No professional profile loaded yet. Upload your resume or CV to enable AI-powered
          personalization.
        </p>
        <button
          onClick={() => window.electronAPI?.profileSelectFile?.()}
          className="mt-4 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition-colors"
        >
          Upload Resume
        </button>
      </div>
    );
  }

  const identity = profileData.identity;
  const skills = profileData.skills || [];
  const experienceCount = profileData.experienceCount || 0;
  const projectCount = profileData.projectCount || 0;
  const nodeCount = profileData.nodeCount || 0;
  const professionalProfile = profileData.professionalProfile;

  return (
    <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-4">
          {identity?.name ? (
            <div className="w-14 h-14 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
              <span className="text-xl font-semibold text-purple-400">
                {identity.name.charAt(0).toUpperCase()}
              </span>
            </div>
          ) : (
            <div className="w-14 h-14 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0">
              <User size={24} className="text-white/30" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-white/90 font-semibold text-lg truncate">
              {identity?.name || 'Unknown'}
            </h3>
            {identity?.email && (
              <p className="text-white/50 text-sm truncate">{identity.email}</p>
            )}
            {professionalProfile?.role && (
              <p className="text-purple-400/80 text-xs mt-0.5 truncate">
                {professionalProfile.role}
                {professionalProfile.company ? ` at ${professionalProfile.company}` : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 divide-x divide-white/[0.06] border-b border-white/[0.06]">
        <div className="p-4 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Briefcase size={14} className="text-purple-400/70" />
            <span className="text-xl font-semibold text-white/80">{experienceCount}</span>
          </div>
          <p className="text-[10px] text-white/40 uppercase tracking-wider">Experience</p>
        </div>
        <div className="p-4 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Layers size={14} className="text-emerald-400/70" />
            <span className="text-xl font-semibold text-white/80">{projectCount}</span>
          </div>
          <p className="text-[10px] text-white/40 uppercase tracking-wider">Projects</p>
        </div>
        <div className="p-4 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <FileText size={14} className="text-amber-400/70" />
            <span className="text-xl font-semibold text-white/80">{nodeCount}</span>
          </div>
          <p className="text-[10px] text-white/40 uppercase tracking-wider">Highlights</p>
        </div>
      </div>

      {/* Professional profile fields */}
      {professionalProfile && (
        <div className="p-5 border-b border-white/[0.06] space-y-3">
          {professionalProfile.seniority && (
            <div className="flex items-center gap-2">
              <GraduationCap size={14} className="text-white/40 shrink-0" />
              <span className="text-xs text-white/50">Seniority:</span>
              <span className="text-xs text-white/80 font-medium">
                {SENIORITY_LABELS[professionalProfile.seniority] || professionalProfile.seniority}
              </span>
            </div>
          )}

          {professionalProfile.mainStack && professionalProfile.mainStack.length > 0 && (
            <div className="flex items-start gap-2">
              <Code2 size={14} className="text-white/40 mt-0.5 shrink-0" />
              <span className="text-xs text-white/50 shrink-0">Stack:</span>
              <div className="flex flex-wrap gap-1">
                {professionalProfile.mainStack.map((tech, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/15 text-[10px] text-purple-400/80"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          )}

          {professionalProfile.currentProjects && professionalProfile.currentProjects.length > 0 && (
            <div className="flex items-start gap-2">
              <FolderKanban size={14} className="text-white/40 mt-0.5 shrink-0" />
              <span className="text-xs text-white/50 shrink-0">Projects:</span>
              <div className="flex flex-wrap gap-1">
                {professionalProfile.currentProjects.map((proj, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/15 text-[10px] text-emerald-400/80"
                  >
                    {proj}
                  </span>
                ))}
              </div>
            </div>
          )}

          {professionalProfile.meetingContext && (
            <div className="flex items-start gap-2">
              <MessageSquareText size={14} className="text-white/40 mt-0.5 shrink-0" />
              <span className="text-xs text-white/50 shrink-0">Meetings:</span>
              <span className="text-xs text-white/70">{professionalProfile.meetingContext}</span>
            </div>
          )}

          {professionalProfile.interviewTargetRole && (
            <div className="flex items-start gap-2">
              <Target size={14} className="text-white/40 mt-0.5 shrink-0" />
              <span className="text-xs text-white/50 shrink-0">Target:</span>
              <span className="text-xs text-white/70">
                {professionalProfile.interviewTargetRole}
              </span>
            </div>
          )}

          {professionalProfile.preferredSuggestionStyle && (
            <div className="flex items-center gap-2">
              <MessageSquareText size={14} className="text-white/40 shrink-0" />
              <span className="text-xs text-white/50">Style:</span>
              <span className="text-xs text-white/80 font-medium">
                {STYLE_LABELS[professionalProfile.preferredSuggestionStyle] ||
                  professionalProfile.preferredSuggestionStyle}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <div className="p-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 mb-3">
            <Code2 size={14} className="text-white/40" />
            <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">
              Skills & Technologies
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((skill, i) => (
              <span
                key={i}
                className="px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white/70"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Active JD */}
      {profileData.hasActiveJD && profileData.activeJD && (
        <div className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Building2 size={14} className="text-white/40" />
            <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">
              Active Job Description
            </span>
          </div>
          <div className="rounded-lg bg-white/[0.04] border border-white/[0.08] p-3">
            <p className="text-sm text-white/80 font-medium">
              {profileData.activeJD.title}
            </p>
            <p className="text-xs text-white/50 mt-0.5">{profileData.activeJD.company}</p>
            {profileData.activeJD.level && (
              <span className="inline-block mt-2 px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/20 text-[10px] text-purple-400">
                {profileData.activeJD.level}
              </span>
            )}
            {profileData.activeJD.technologies && profileData.activeJD.technologies.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {profileData.activeJD.technologies.map((tech, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded bg-white/[0.06] text-[10px] text-white/60"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
