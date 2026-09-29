// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Group, Input, Paper, Stack, Text } from '@mantine/core';
import { createReference } from '@medplum/core';
import type { Practitioner, Reference } from '@medplum/fhirtypes';
import { AnnotationInput, ResourceAvatar, useMedplumProfile } from '@medplum/react';
import { IconLock, IconSignature } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { showErrorNotification } from '../../utils/notifications';

interface SignLockDialogProps {
  onSign: (practitioner: Reference<Practitioner>, lock: boolean, reason?: string) => void;
  /** Ask for a documented reason before either sign button is enabled. */
  requireReason?: boolean;
}

export const SignLockDialog = (props: SignLockDialogProps): JSX.Element => {
  const { onSign, requireReason = false } = props;
  const [reason, setReason] = useState('');
  const missingReason = requireReason && !reason.trim();
  const author = useMedplumProfile();
  const authorReference = author ? (createReference(author) as Reference<Practitioner>) : undefined;

  const handleSign = (lock: boolean): void => {
    if (!authorReference) {
      showErrorNotification('No author information found');
      return;
    }

    onSign(authorReference, lock, requireReason ? reason.trim() : undefined);
  };

  return (
    <Stack gap="md">
      <Paper p="sm" withBorder radius="md">
        <Group gap="sm">
          <ResourceAvatar value={authorReference} radius="xl" size={36} />
          <Text size="sm" fw={500}>
            {authorReference?.display}
          </Text>
        </Group>
      </Paper>

      {requireReason && (
        <Input.Wrapper
          label="Reason for signing despite the consistency check"
          description="Recorded with the signature, for example why the documented dose is intended."
          withAsterisk
        >
          <AnnotationInput
            name="reason"
            path="Provenance.reason.text"
            onChange={(value) => setReason(value.text ?? '')}
          />
        </Input.Wrapper>
      )}

      <Stack gap={0}>
        <Button
          fullWidth
          leftSection={<IconLock size={18} />}
          onClick={() => handleSign(true)}
          mt="md"
          disabled={missingReason}
        >
          Sign & Lock Note
        </Button>

        <Button
          variant="outline"
          fullWidth
          leftSection={<IconSignature size={18} />}
          onClick={() => handleSign(false)}
          mt="md"
          disabled={missingReason}
        >
          Just Sign
        </Button>
      </Stack>
    </Stack>
  );
};
