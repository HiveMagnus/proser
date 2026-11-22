import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../accordion';

describe('Accordion', () => {
  const renderAccordion = () =>
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Section One</AccordionTrigger>
          <AccordionContent>Content of section one</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Section Two</AccordionTrigger>
          <AccordionContent>Content of section two</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

  it('renders trigger labels', () => {
    renderAccordion();
    expect(screen.getByText('Section One')).toBeInTheDocument();
    expect(screen.getByText('Section Two')).toBeInTheDocument();
  });

  it('content is hidden by default when collapsible', () => {
    renderAccordion();
    // Radix hides content with data-state="closed"
    const triggers = screen.getAllByRole('button');
    expect(triggers).toHaveLength(2);
  });

  it('expands an item on click', async () => {
    const user = userEvent.setup();
    renderAccordion();
    const trigger = screen.getByText('Section One');
    await user.click(trigger);
    expect(screen.getByText('Content of section one')).toBeVisible();
  });
});
