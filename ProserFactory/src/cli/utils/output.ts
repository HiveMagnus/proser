import chalk from 'chalk';
import ora, { Ora } from 'ora';

export class CliOutput {
  private spinner: Ora | null = null;

  success(message: string): void {
    console.log(chalk.green('✓'), message);
  }

  error(message: string): void {
    console.error(chalk.red('✗'), message);
  }

  warning(message: string): void {
    console.log(chalk.yellow('⚠'), message);
  }

  info(message: string): void {
    console.log(chalk.blue('ℹ'), message);
  }

  section(title: string): void {
    console.log('\n' + chalk.bold.cyan(title));
    console.log(chalk.cyan('─'.repeat(title.length)));
  }

  data(label: string, value: string | number): void {
    console.log(chalk.gray(label + ':'), chalk.white(value));
  }

  startSpinner(message: string): void {
    this.spinner = ora(message).start();
  }

  updateSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.text = message;
    }
  }

  succeedSpinner(message?: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
      this.spinner = null;
    }
  }

  failSpinner(message?: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    }
  }

  stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  newline(): void {
    console.log();
  }

  table(data: Record<string, string | number>[]): void {
    if (data.length === 0) {
      this.warning('No data to display');
      return;
    }

    const headers = Object.keys(data[0]);
    const colWidths = headers.map(header =>
      Math.max(
        header.length,
        ...data.map(row => String(row[header] || '').length)
      )
    );

    // Print header
    console.log(
      headers
        .map((h, i) => chalk.bold(h.padEnd(colWidths[i])))
        .join('  ')
    );
    console.log(headers.map((_, i) => '─'.repeat(colWidths[i])).join('  '));

    // Print rows
    data.forEach(row => {
      console.log(
        headers
          .map((h, i) => String(row[h] || '').padEnd(colWidths[i]))
          .join('  ')
      );
    });
  }

  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }
}

export const output = new CliOutput();
