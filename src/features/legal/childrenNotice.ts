import { list, p, placeholder, type LegalDocument, type LegalSection } from '@/features/legal/legalDocument';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import { features } from '@/lib/features';

/**
 * The Children's Privacy Notice, as data. A DRAFT: counsel has not reviewed
 * it, and its first block says so on the page.
 *
 * It explains how Cleffy treats children under 13: they cannot have accounts,
 * and a teacher may still use Cleffy with them on the teacher's own screen.
 * It must never claim COPPA compliance (childrenNotice.test.ts scans every
 * document for that).
 *
 * The view-links section appears only while VITE_FEATURE_VIEW_LINKS is on
 * (src/lib/features.ts), like the AI sections of the Privacy Policy: the
 * notice covers what this build does.
 */

const { brand, name, legalForm, postalAddress, emails } = LEGAL_ENTITY;

const viewLinkSections: LegalSection[] = features.viewLinks
    ? [
          {
              id: 'view-links',
              heading: 'View links',
              blocks: [
                  p(
                      'A teacher can send a young student a view link: a read-only link to one score, so the student can see it at home. Opening a view link:',
                  ),
                  list(
                      'needs no account, no name and no other input from the person opening it, and sets no cookies and stores nothing on their device;',
                      'means our hosting provider processes the viewer’s IP address, only to deliver the page and keep it secure and working;',
                      `stores nothing about the viewer in ${brand}’s database;`,
                      'is never used to contact anyone, to show advertising or to build a profile.',
                  ),
                  placeholder('Counsel: retention wording (Vercel runtime logs 1 h; …)'),
              ],
          },
      ]
    : [];

export const CHILDREN_NOTICE: LegalDocument = {
    id: 'children',
    title: 'Children’s Privacy Notice',
    shortTitle: 'Children’s privacy',
    summary: `How ${name} treats information about children under 13, and how teachers can use ${brand} with younger students.`,
    sections: [
        {
            id: 'who-we-are',
            heading: 'Who we are',
            blocks: [
                placeholder('DRAFT — awaiting legal review. Not in effect.'),
                p(
                    `${brand} is run by ${name}, ${legalForm}, ${postalAddress}. You can reach us at ${emails.privacy} about children’s privacy, or at ${emails.support} for anything else.`,
                ),
                placeholder('Phone number — Max to supply'),
            ],
        },
        {
            id: 'no-accounts',
            heading: 'Children under 13 don’t have Cleffy accounts',
            blocks: [
                list(
                    'Anyone who creates an account themselves, or joins a shared score as a guest through a share link, first answers an age check. If they do not meet the minimum age where they live (13, or older in some countries), no account is created.',
                    'A teacher who creates a student account confirms that the student meets the minimum age for the student’s country.',
                ),
            ],
        },
        {
            id: 'teacher-screen',
            heading: 'Using Cleffy with a young student on the teacher’s own screen',
            blocks: [
                p(
                    `A teacher may use ${brand} in lessons with a student under the minimum age by showing a score on the teacher’s own device. The student does not sign in or type anything, and ${brand} collects nothing from the student.`,
                ),
            ],
        },
        ...viewLinkSections,
        {
            id: 'retention',
            heading: 'How long we keep information',
            blocks: [
                p(
                    `Because children under 13 do not have accounts, ${brand} does not hold their information. If we learn that we hold some anyway, we delete it. How long we keep everyone else’s information is set out in our Privacy Policy.`,
                ),
            ],
        },
        {
            id: 'parents',
            heading: 'Parents',
            blocks: [
                p(
                    `If you are a parent or guardian and think your child under 13 has given us information, write to ${emails.privacy}. We delete anything we learn was collected from a child under 13.`,
                ),
            ],
        },
        {
            id: 'status',
            heading: 'Status of this notice',
            blocks: [
                p('This notice is a draft. It is not in effect until counsel has reviewed it.'),
                placeholder(
                    'Counsel to confirm the internal-operations basis (16 CFR 312.5(c)(7)) and the notice contents (312.4(d)).',
                ),
            ],
        },
    ],
};
