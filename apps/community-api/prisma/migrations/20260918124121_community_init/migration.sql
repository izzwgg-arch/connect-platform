-- CreateEnum
CREATE TYPE "PersonStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'PENDING_DELETION', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "CodePurpose" AS ENUM ('EMAIL_VERIFY', 'PHONE_VERIFY', 'PASSWORD_RESET', 'LOGIN_OTP', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'CONNECTIONS', 'ORGANIZATION', 'PRIVATE');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'RECRUITER', 'SALES', 'MARKETING', 'BILLING_ADMIN', 'MODERATOR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AffiliationStatus" AS ENUM ('PENDING', 'VERIFIED_DOMAIN', 'VERIFIED_ADMIN', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationKind" AS ENUM ('IDENTITY', 'PHONE', 'EMAIL', 'DOMAIN', 'BUSINESS', 'EMPLOYEE', 'LICENSE', 'INSURANCE', 'LOOPCOM_CUSTOMER', 'TRANSACTION');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'WITHDRAWN', 'IGNORED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RelationshipKind" AS ENUM ('WORKED_WITH', 'PURCHASED_FROM', 'SOLD_TO', 'REFERRED', 'PARTNER', 'CUSTOMER', 'VENDOR', 'MENTOR');

-- CreateEnum
CREATE TYPE "PostKind" AS ENUM ('TEXT', 'IMAGE', 'GALLERY', 'VIDEO', 'DOCUMENT', 'LINK', 'POLL', 'ARTICLE', 'COMPANY_UPDATE', 'JOB', 'EVENT', 'OPPORTUNITY', 'RFQ', 'LISTING', 'REPOST');

-- CreateEnum
CREATE TYPE "ThreadKind" AS ENUM ('DIRECT', 'GROUP', 'RFQ', 'EVENT', 'GROUP_CHAT', 'INTRO');

-- CreateEnum
CREATE TYPE "ParticipantState" AS ENUM ('ACTIVE', 'REQUESTED', 'DECLINED', 'LEFT');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'SYSTEM', 'QUOTE_CARD');

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "GroupMemberState" AS ENUM ('ACTIVE', 'PENDING', 'BANNED', 'LEFT');

-- CreateEnum
CREATE TYPE "EventMode" AS ENUM ('ONLINE', 'IN_PERSON', 'HYBRID');

-- CreateEnum
CREATE TYPE "RsvpStatus" AS ENUM ('GOING', 'INTERESTED', 'NOT_GOING', 'WAITLIST');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('APPLIED', 'REVIEWED', 'INTERVIEW', 'OFFER', 'HIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ListingType" AS ENUM ('SERVICE', 'PRODUCT', 'WHOLESALE', 'BUSINESS_ASSET', 'PROFESSIONAL_SERVICE');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'OPEN', 'SHORTLISTING', 'ACCEPTED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('SUBMITTED', 'SHORTLISTED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "IntroStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED', 'WITHDRAWN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'SCAM', 'HARASSMENT', 'IMPERSONATION', 'PHISHING', 'MALWARE', 'FAKE_JOB', 'FAKE_COMPANY', 'FAKE_REVIEW', 'BOT', 'MASS_SOLICITATION', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED', 'APPEALED');

-- CreateEnum
CREATE TYPE "ModerationActionKind" AS ENUM ('WARN', 'RESTRICT_OUTREACH', 'REMOVE_CONTENT', 'SUSPEND', 'BAN', 'DISMISS', 'APPEAL_GRANTED', 'APPEAL_DENIED', 'NOTE');

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phoneE164" TEXT,
    "passwordHash" TEXT,
    "status" "PersonStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "loopcomUserId" TEXT,
    "loopcomTenantId" TEXT,
    "loopcomEmail" TEXT,
    "mfaTotpSecret" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "onboardingDoneAt" TIMESTAMP(3),
    "deleteAfter" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "deviceLabel" TEXT,
    "client" TEXT NOT NULL DEFAULT 'web',
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCode" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "purpose" "CodePurpose" NOT NULL,
    "target" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "personId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "headline" TEXT,
    "about" TEXT,
    "avatarAssetId" TEXT,
    "coverAssetId" TEXT,
    "location" TEXT,
    "serviceArea" TEXT[],
    "languages" TEXT[],
    "industry" TEXT,
    "objectives" TEXT[],
    "skills" TEXT[],
    "links" JSONB,
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("personId")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "organizationId" TEXT,
    "companyName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "degree" TEXT,
    "field" TEXT,
    "startYear" INTEGER,
    "endYear" INTEGER,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileService" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceFrom" DECIMAL(12,2),
    "priceNote" TEXT,

    CONSTRAINT "ProfileService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "assetId" TEXT,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioItem" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assetId" TEXT,
    "url" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PortfolioItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacySetting" (
    "personId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL,

    CONSTRAINT "PrivacySetting_pkey" PRIMARY KEY ("personId","category")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Endorsement" (
    "id" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Endorsement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "logoAssetId" TEXT,
    "coverAssetId" TEXT,
    "description" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "foundedYear" INTEGER,
    "website" TEXT,
    "domain" TEXT,
    "domainVerifiedAt" TIMESTAMP(3),
    "phone" TEXT,
    "smsNumber" TEXT,
    "whatsappNumber" TEXT,
    "email" TEXT,
    "hours" JSONB,
    "serviceArea" TEXT[],
    "loopcomTenantId" TEXT,
    "loopcomLinkedAt" TIMESTAMP(3),
    "acceptsRfqs" BOOLEAN NOT NULL DEFAULT true,
    "showPhone" BOOLEAN NOT NULL DEFAULT true,
    "showEmail" BOOLEAN NOT NULL DEFAULT true,
    "showWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "openMessages" BOOLEAN NOT NULL DEFAULT true,
    "searchEngineVisible" BOOLEAN NOT NULL DEFAULT true,
    "searchText" TEXT,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address1" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "phone" TEXT,
    "isHeadquarters" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrgLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'EMPLOYEE',
    "permissions" TEXT[],
    "title" TEXT,
    "affiliation" "AffiliationStatus" NOT NULL DEFAULT 'PENDING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "showOnProfile" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgInvite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'EMPLOYEE',
    "permissions" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "organizationId" TEXT,
    "kind" "VerificationKind" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "assetId" TEXT,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "personId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "Mute" (
    "personId" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "targetOrgId" TEXT,
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipTag" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "targetOrgId" TEXT,
    "kind" "RelationshipKind" NOT NULL,
    "mutual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelationshipTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "organizationId" TEXT,
    "kind" "PostKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC',
    "commentsPolicy" TEXT NOT NULL DEFAULT 'ANYONE',
    "linkUrl" TEXT,
    "linkPreview" JSONB,
    "refType" TEXT,
    "refId" TEXT,
    "repostComment" TEXT,
    "altText" TEXT,
    "industry" TEXT,
    "location" TEXT,
    "groupId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "reactionCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "repostCount" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "impressionCount" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "altText" TEXT,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "personId" TEXT,
    "orgId" TEXT,

    CONSTRAINT "Mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "reactionCount" INTEGER NOT NULL DEFAULT 0,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reaction" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Save" (
    "personId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Save_pkey" PRIMARY KEY ("personId","postId")
);

-- CreateTable
CREATE TABLE "Poll" (
    "postId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3),

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "voteCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "pollId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("pollId","personId")
);

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "authorId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "publishedPostId" TEXT,
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hide" (
    "personId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hide_pkey" PRIMARY KEY ("personId","postId")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "kind" "ThreadKind" NOT NULL DEFAULT 'DIRECT',
    "title" TEXT,
    "pairKey" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "groupId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadParticipant" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "state" "ParticipantState" NOT NULL DEFAULT 'ACTIVE',
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "lastReadAt" TIMESTAMP(3),
    "mutedUntil" TIMESTAMP(3),
    "pinnedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "replyToId" TEXT,
    "forwardedFromId" TEXT,
    "assetId" TEXT,
    "linkPreview" JSONB,
    "refType" TEXT,
    "refId" TEXT,
    "reactions" JSONB,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "rules" TEXT,
    "coverAssetId" TEXT,
    "logoAssetId" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "chatThreadId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "state" "GroupMemberState" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","personId")
);

-- CreateTable
CREATE TABLE "GroupFile" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "mode" "EventMode" NOT NULL DEFAULT 'IN_PERSON',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "venue" TEXT,
    "address" TEXT,
    "onlineUrl" TEXT,
    "capacity" INTEGER,
    "isFree" BOOLEAN NOT NULL DEFAULT true,
    "price" DECIMAL(10,2),
    "coverAssetId" TEXT,
    "attendeeListVisibility" TEXT NOT NULL DEFAULT 'ATTENDEES',
    "organizationId" TEXT,
    "groupId" TEXT,
    "hostId" TEXT NOT NULL,
    "speakers" JSONB,
    "sponsors" JSONB,
    "chatThreadId" TEXT,
    "rsvpCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRsvp" (
    "eventId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL DEFAULT 'GOING',
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "reminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRsvp_pkey" PRIMARY KEY ("eventId","personId")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'FULL_TIME',
    "workMode" TEXT NOT NULL DEFAULT 'ONSITE',
    "salaryMin" DECIMAL(12,2),
    "salaryMax" DECIMAL(12,2),
    "salaryPeriod" TEXT NOT NULL DEFAULT 'YEAR',
    "requirements" TEXT[],
    "languages" TEXT[],
    "status" "JobStatus" NOT NULL DEFAULT 'OPEN',
    "promotedUntil" TIMESTAMP(3),
    "applicantCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "profileSnapshot" JSONB NOT NULL,
    "resumeAssetId" TEXT,
    "coverNote" TEXT,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'APPLIED',
    "employerNotes" TEXT,
    "viewedAt" TIMESTAMP(3),
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAlert" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "location" TEXT,
    "filters" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MARKETPLACE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "sellerPersonId" TEXT,
    "organizationId" TEXT,
    "categoryId" TEXT,
    "type" "ListingType" NOT NULL DEFAULT 'SERVICE',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceMin" DECIMAL(12,2),
    "priceMax" DECIMAL(12,2),
    "priceUnit" TEXT,
    "minimumOrder" TEXT,
    "turnaround" TEXT,
    "delivery" TEXT,
    "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "serviceArea" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingMedia" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ListingMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceNote" TEXT,
    "assetId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "buyerPersonId" TEXT NOT NULL,
    "organizationId" TEXT,
    "categoryId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" TEXT,
    "budgetMin" DECIMAL(12,2),
    "budgetMax" DECIMAL(12,2),
    "location" TEXT,
    "deadline" TIMESTAMP(3),
    "requirements" TEXT[],
    "extracted" JSONB,
    "extractionConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "status" "RfqStatus" NOT NULL DEFAULT 'OPEN',
    "closesAt" TIMESTAMP(3),
    "acceptedQuoteId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'MATCHED',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "quoteCount" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqAttachment" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "RfqAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqInvite" (
    "rfqId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reason" TEXT,
    "viewedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqInvite_pkey" PRIMARY KEY ("rfqId","organizationId")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "perUnit" DECIMAL(12,2),
    "deliveryDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "alternateProposal" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SUBMITTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteAttachment" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "QuoteAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqQuestion" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "askedById" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityType" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fieldSchema" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OpportunityType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "posterId" TEXT NOT NULL,
    "organizationId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "fields" JSONB,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "interestCount" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityInterest" (
    "opportunityId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "message" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityInterest_pkey" PRIMARY KEY ("opportunityId","personId")
);

-- CreateTable
CREATE TABLE "IntroRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "middleId" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "targetOrgId" TEXT,
    "message" TEXT,
    "draft" TEXT,
    "status" "IntroStatus" NOT NULL DEFAULT 'REQUESTED',
    "threadId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntroRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateNote" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "targetOrgId" TEXT,
    "body" TEXT NOT NULL,
    "tags" TEXT[],
    "dealValue" DECIMAL(12,2),
    "nextAction" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetPersonId" TEXT,
    "targetOrgId" TEXT,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "actorId" TEXT,
    "objectType" TEXT,
    "objectId" TEXT,
    "groupKey" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "readAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPref" (
    "personId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "sms" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("personId","kind")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "filters" JSONB,
    "alerts" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentSearch" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" INTEGER,
    "storageKey" TEXT NOT NULL,
    "variants" JSONB,
    "sha256" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "scanResult" TEXT,
    "originalName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "sessionId" TEXT,
    "event" TEXT NOT NULL,
    "objectType" TEXT,
    "objectId" TEXT,
    "client" TEXT,
    "appVersion" TEXT,
    "surface" TEXT,
    "position" INTEGER,
    "recommendationId" TEXT,
    "experimentId" TEXT,
    "props" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "day" DATE NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalyticsDaily_pkey" PRIMARY KEY ("day","objectType","objectId","event")
);

-- CreateTable
CREATE TABLE "RecommendationImpression" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "reason" TEXT,
    "position" INTEGER,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationImpression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout" INTEGER NOT NULL DEFAULT 0,
    "audience" TEXT NOT NULL DEFAULT 'INTERNAL',
    "allowPersons" TEXT[],
    "allowOrgs" TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "population" TEXT NOT NULL,
    "treatment" TEXT NOT NULL,
    "control" TEXT NOT NULL,
    "successMetrics" TEXT[],
    "guardrailMetrics" TEXT[],
    "minSample" INTEGER NOT NULL DEFAULT 100,
    "rollbackCriteria" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentAssignment" (
    "experimentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("experimentId","personId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "caseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "subjectPersonId" TEXT,
    "subjectOrgId" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "reason" "ReportReason" NOT NULL,
    "reportCount" INTEGER NOT NULL DEFAULT 1,
    "signals" JSONB,
    "assignedToId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "kind" "ModerationActionKind" NOT NULL,
    "note" TEXT NOT NULL,
    "userMessage" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restriction" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffGrant" (
    "personId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MODERATOR',
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffGrant_pkey" PRIMARY KEY ("personId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "organizationId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "source" TEXT NOT NULL DEFAULT 'api',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OutreachStat" (
    "personId" TEXT NOT NULL,
    "messagesLast24h" INTEGER NOT NULL DEFAULT 0,
    "requestsLast24h" INTEGER NOT NULL DEFAULT 0,
    "connectionsSent7d" INTEGER NOT NULL DEFAULT 0,
    "acceptedRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "blockCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachStat_pkey" PRIMARY KEY ("personId")
);

-- CreateTable
CREATE TABLE "OutboundMail" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_username_key" ON "Person"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Person_email_key" ON "Person"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Person_phoneE164_key" ON "Person"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "Person_loopcomUserId_key" ON "Person"("loopcomUserId");

-- CreateIndex
CREATE INDEX "Person_status_idx" ON "Person"("status");

-- CreateIndex
CREATE INDEX "Person_loopcomTenantId_idx" ON "Person"("loopcomTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_personId_revokedAt_idx" ON "Session"("personId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialId_key" ON "Passkey"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_subject_key" ON "OAuthAccount"("provider", "subject");

-- CreateIndex
CREATE INDEX "VerificationCode_target_purpose_usedAt_idx" ON "VerificationCode"("target", "purpose", "usedAt");

-- CreateIndex
CREATE INDEX "Profile_industry_idx" ON "Profile"("industry");

-- CreateIndex
CREATE INDEX "Experience_personId_idx" ON "Experience"("personId");

-- CreateIndex
CREATE INDEX "Education_personId_idx" ON "Education"("personId");

-- CreateIndex
CREATE INDEX "ProfileService_personId_idx" ON "ProfileService"("personId");

-- CreateIndex
CREATE INDEX "Certification_personId_idx" ON "Certification"("personId");

-- CreateIndex
CREATE INDEX "PortfolioItem_personId_idx" ON "PortfolioItem"("personId");

-- CreateIndex
CREATE INDEX "Recommendation_subjectId_acceptedAt_idx" ON "Recommendation"("subjectId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_authorId_subjectId_key" ON "Recommendation"("authorId", "subjectId");

-- CreateIndex
CREATE INDEX "Endorsement_personId_skill_idx" ON "Endorsement"("personId", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "Endorsement_byId_personId_skill_key" ON "Endorsement"("byId", "personId", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_loopcomTenantId_key" ON "Organization"("loopcomTenantId");

-- CreateIndex
CREATE INDEX "Organization_industry_idx" ON "Organization"("industry");

-- CreateIndex
CREATE INDEX "Organization_domain_idx" ON "Organization"("domain");

-- CreateIndex
CREATE INDEX "OrgLocation_organizationId_idx" ON "OrgLocation"("organizationId");

-- CreateIndex
CREATE INDEX "Membership_organizationId_role_idx" ON "Membership"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_personId_organizationId_key" ON "Membership"("personId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvite_tokenHash_key" ON "OrgInvite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvite_organizationId_email_key" ON "OrgInvite"("organizationId", "email");

-- CreateIndex
CREATE INDEX "Verification_personId_kind_status_idx" ON "Verification"("personId", "kind", "status");

-- CreateIndex
CREATE INDEX "Verification_organizationId_kind_status_idx" ON "Verification"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "Verification_status_idx" ON "Verification"("status");

-- CreateIndex
CREATE INDEX "Connection_bId_status_idx" ON "Connection"("bId", "status");

-- CreateIndex
CREATE INDEX "Connection_aId_status_idx" ON "Connection"("aId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_aId_bId_key" ON "Connection"("aId", "bId");

-- CreateIndex
CREATE INDEX "Follow_personId_idx" ON "Follow"("personId");

-- CreateIndex
CREATE INDEX "Follow_organizationId_idx" ON "Follow"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_personId_key" ON "Follow"("followerId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_organizationId_key" ON "Follow"("followerId", "organizationId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Mute_personId_targetPersonId_key" ON "Mute"("personId", "targetPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "Mute_personId_targetOrgId_key" ON "Mute"("personId", "targetOrgId");

-- CreateIndex
CREATE INDEX "RelationshipTag_targetOrgId_kind_mutual_idx" ON "RelationshipTag"("targetOrgId", "kind", "mutual");

-- CreateIndex
CREATE INDEX "RelationshipTag_targetPersonId_kind_mutual_idx" ON "RelationshipTag"("targetPersonId", "kind", "mutual");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipTag_ownerId_targetPersonId_kind_key" ON "RelationshipTag"("ownerId", "targetPersonId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipTag_ownerId_targetOrgId_kind_key" ON "RelationshipTag"("ownerId", "targetOrgId", "kind");

-- CreateIndex
CREATE INDEX "Post_authorId_publishedAt_idx" ON "Post"("authorId", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_organizationId_publishedAt_idx" ON "Post"("organizationId", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_publishedAt_idx" ON "Post"("publishedAt");

-- CreateIndex
CREATE INDEX "Post_groupId_publishedAt_idx" ON "Post"("groupId", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_kind_publishedAt_idx" ON "Post"("kind", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_scheduledFor_idx" ON "Post"("scheduledFor");

-- CreateIndex
CREATE INDEX "PostMedia_postId_idx" ON "PostMedia"("postId");

-- CreateIndex
CREATE INDEX "Mention_personId_idx" ON "Mention"("personId");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE INDEX "Reaction_postId_idx" ON "Reaction"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "Reaction_personId_postId_key" ON "Reaction"("personId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "Reaction_personId_commentId_key" ON "Reaction"("personId", "commentId");

-- CreateIndex
CREATE INDEX "ScheduledPost_scheduledFor_publishedPostId_idx" ON "ScheduledPost"("scheduledFor", "publishedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_pairKey_key" ON "Thread"("pairKey");

-- CreateIndex
CREATE INDEX "Thread_kind_refType_refId_idx" ON "Thread"("kind", "refType", "refId");

-- CreateIndex
CREATE INDEX "Thread_groupId_idx" ON "Thread"("groupId");

-- CreateIndex
CREATE INDEX "ThreadParticipant_personId_state_archivedAt_idx" ON "ThreadParticipant"("personId", "state", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadParticipant_threadId_personId_key" ON "ThreadParticipant"("threadId", "personId");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message"("senderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Group_chatThreadId_key" ON "Group"("chatThreadId");

-- CreateIndex
CREATE INDEX "Group_category_idx" ON "Group"("category");

-- CreateIndex
CREATE INDEX "GroupMember_personId_state_idx" ON "GroupMember"("personId", "state");

-- CreateIndex
CREATE INDEX "GroupFile_groupId_idx" ON "GroupFile"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_chatThreadId_key" ON "Event"("chatThreadId");

-- CreateIndex
CREATE INDEX "Event_startsAt_idx" ON "Event"("startsAt");

-- CreateIndex
CREATE INDEX "Event_organizationId_idx" ON "Event"("organizationId");

-- CreateIndex
CREATE INDEX "EventRsvp_personId_idx" ON "EventRsvp"("personId");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_status_idx" ON "Job"("organizationId", "status");

-- CreateIndex
CREATE INDEX "JobApplication_personId_createdAt_idx" ON "JobApplication"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "JobApplication_jobId_stage_idx" ON "JobApplication"("jobId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "JobApplication_jobId_personId_key" ON "JobApplication"("jobId", "personId");

-- CreateIndex
CREATE INDEX "JobAlert_personId_idx" ON "JobAlert"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Category_kind_idx" ON "Category"("kind");

-- CreateIndex
CREATE INDEX "Listing_categoryId_status_idx" ON "Listing"("categoryId", "status");

-- CreateIndex
CREATE INDEX "Listing_organizationId_idx" ON "Listing"("organizationId");

-- CreateIndex
CREATE INDEX "Listing_type_status_idx" ON "Listing"("type", "status");

-- CreateIndex
CREATE INDEX "CatalogItem_organizationId_idx" ON "CatalogItem"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_number_key" ON "Rfq"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_acceptedQuoteId_key" ON "Rfq"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "Rfq_status_createdAt_idx" ON "Rfq"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Rfq_buyerPersonId_idx" ON "Rfq"("buyerPersonId");

-- CreateIndex
CREATE INDEX "Rfq_categoryId_status_idx" ON "Rfq"("categoryId", "status");

-- CreateIndex
CREATE INDEX "RfqInvite_organizationId_declinedAt_idx" ON "RfqInvite"("organizationId", "declinedAt");

-- CreateIndex
CREATE INDEX "Quote_organizationId_status_idx" ON "Quote"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_rfqId_organizationId_key" ON "Quote"("rfqId", "organizationId");

-- CreateIndex
CREATE INDEX "RfqQuestion_rfqId_idx" ON "RfqQuestion"("rfqId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityType_slug_key" ON "OpportunityType"("slug");

-- CreateIndex
CREATE INDEX "Opportunity_typeId_status_createdAt_idx" ON "Opportunity"("typeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Opportunity_posterId_idx" ON "Opportunity"("posterId");

-- CreateIndex
CREATE INDEX "IntroRequest_middleId_status_idx" ON "IntroRequest"("middleId", "status");

-- CreateIndex
CREATE INDEX "IntroRequest_requesterId_idx" ON "IntroRequest"("requesterId");

-- CreateIndex
CREATE INDEX "PrivateNote_ownerId_targetPersonId_idx" ON "PrivateNote"("ownerId", "targetPersonId");

-- CreateIndex
CREATE INDEX "PrivateNote_ownerId_targetOrgId_idx" ON "PrivateNote"("ownerId", "targetOrgId");

-- CreateIndex
CREATE INDEX "Reminder_ownerId_dueAt_doneAt_idx" ON "Reminder"("ownerId", "dueAt", "doneAt");

-- CreateIndex
CREATE INDEX "Reminder_dueAt_notifiedAt_idx" ON "Reminder"("dueAt", "notifiedAt");

-- CreateIndex
CREATE INDEX "Notification_personId_readAt_createdAt_idx" ON "Notification"("personId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_personId_groupKey_idx" ON "Notification"("personId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_personId_idx" ON "DeviceToken"("personId");

-- CreateIndex
CREATE INDEX "SavedSearch_personId_idx" ON "SavedSearch"("personId");

-- CreateIndex
CREATE INDEX "RecentSearch_personId_createdAt_idx" ON "RecentSearch"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_createdAt_idx" ON "MediaAsset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_event_occurredAt_idx" ON "AnalyticsEvent"("event", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_objectType_objectId_occurredAt_idx" ON "AnalyticsEvent"("objectType", "objectId", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_personId_occurredAt_idx" ON "AnalyticsEvent"("personId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecommendationImpression_personId_createdAt_idx" ON "RecommendationImpression"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationImpression_objectType_objectId_idx" ON "RecommendationImpression"("objectType", "objectId");

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_key_key" ON "Experiment"("key");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetType_targetId_key" ON "Report"("reporterId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "ModerationCase_status_createdAt_idx" ON "ModerationCase"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModerationCase_targetType_targetId_status_key" ON "ModerationCase"("targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "ModerationAction_caseId_createdAt_idx" ON "ModerationAction"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "Restriction_personId_kind_expiresAt_idx" ON "Restriction"("personId", "kind", "expiresAt");

-- CreateIndex
CREATE INDEX "Appeal_personId_idx" ON "Appeal"("personId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx" ON "AuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE INDEX "OutboundMail_to_createdAt_idx" ON "OutboundMail"("to", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Profile"("personId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Profile"("personId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileService" ADD CONSTRAINT "ProfileService_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Profile"("personId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Profile"("personId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Profile"("personId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacySetting" ADD CONSTRAINT "PrivacySetting_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endorsement" ADD CONSTRAINT "Endorsement_byId_fkey" FOREIGN KEY ("byId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgLocation" ADD CONSTRAINT "OrgLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_aId_fkey" FOREIGN KEY ("aId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_bId_fkey" FOREIGN KEY ("bId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mute" ADD CONSTRAINT "Mute_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipTag" ADD CONSTRAINT "RelationshipTag_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Save" ADD CONSTRAINT "Save_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Save" ADD CONSTRAINT "Save_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("postId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("postId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFile" ADD CONSTRAINT "GroupFile_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRsvp" ADD CONSTRAINT "EventRsvp_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRsvp" ADD CONSTRAINT "EventRsvp_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerPersonId_fkey" FOREIGN KEY ("sellerPersonId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMedia" ADD CONSTRAINT "ListingMedia_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_buyerPersonId_fkey" FOREIGN KEY ("buyerPersonId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqAttachment" ADD CONSTRAINT "RfqAttachment_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqInvite" ADD CONSTRAINT "RfqInvite_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqInvite" ADD CONSTRAINT "RfqInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteAttachment" ADD CONSTRAINT "QuoteAttachment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqQuestion" ADD CONSTRAINT "RfqQuestion_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "OpportunityType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_posterId_fkey" FOREIGN KEY ("posterId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityInterest" ADD CONSTRAINT "OpportunityInterest_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityInterest" ADD CONSTRAINT "OpportunityInterest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntroRequest" ADD CONSTRAINT "IntroRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntroRequest" ADD CONSTRAINT "IntroRequest_middleId_fkey" FOREIGN KEY ("middleId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntroRequest" ADD CONSTRAINT "IntroRequest_targetPersonId_fkey" FOREIGN KEY ("targetPersonId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateNote" ADD CONSTRAINT "PrivateNote_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPref" ADD CONSTRAINT "NotificationPref_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationImpression" ADD CONSTRAINT "RecommendationImpression_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_subjectPersonId_fkey" FOREIGN KEY ("subjectPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_subjectOrgId_fkey" FOREIGN KEY ("subjectOrgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
