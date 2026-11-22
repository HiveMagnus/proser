#!/usr/bin/env perl
use strict;
use warnings;
use utf8;
use Getopt::Long qw(GetOptionsFromArray);
use JSON::PP qw(encode_json);

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my $command = shift @ARGV // '';
usage() unless $command;

if ($command eq 'map') {
    my %opt = (max_excerpt => 180);
    GetOptionsFromArray(\@ARGV, \%opt, 'max-excerpt=i') or usage();
    my $file = shift @ARGV // usage();
    my ($text, $lines) = read_file($file);
    my @headings = headings($lines, $opt{max_excerpt});
    my $words = word_count($text);
    print_json({ ok => JSON::PP::true, file => $file, words => $words, headings => \@headings });
    exit 0;
}

if ($command eq 'search') {
    my %opt = (context => 180, limit => 20, regex => 0, ignore_case => 1);
    GetOptionsFromArray(\@ARGV, \%opt, 'context=i', 'limit=i', 'regex!', 'ignore-case!') or usage();
    my $file = shift @ARGV // usage();
    my $pattern = shift @ARGV // usage();
    my ($text, $lines) = read_file($file);
    my @hits;
    for my $i (0 .. $#$lines) {
        my $line = $lines->[$i];
        my $matched = $opt{regex}
            ? ($opt{ignore_case} ? $line =~ /$pattern/i : $line =~ /$pattern/)
            : (index($opt{ignore_case} ? lc($line) : $line, $opt{ignore_case} ? lc($pattern) : $pattern) >= 0);
        next unless $matched;
        my $start = $i;
        my $end = $i;
        my $excerpt = trim($line);
        while (length($excerpt) < $opt{context} && ($start > 0 || $end < $#$lines)) {
            if ($start > 0) {
                $start--;
                $excerpt = trim($lines->[$start]) . "\n" . $excerpt;
            }
            last if length($excerpt) >= $opt{context};
            if ($end < $#$lines) {
                $end++;
                $excerpt .= "\n" . trim($lines->[$end]);
            }
        }
        push @hits, { line => $i + 1, excerpt => compact(substr($excerpt, 0, $opt{context})) };
        last if @hits >= $opt{limit};
    }
    print_json({ ok => JSON::PP::true, file => $file, pattern => $pattern, hitCount => scalar(@hits), hits => \@hits });
    exit 0;
}

if ($command eq 'slice') {
    my %opt = (heading => '', lines => 80);
    GetOptionsFromArray(\@ARGV, \%opt, 'heading=s', 'lines=i') or usage();
    my $file = shift @ARGV // usage();
    usage() unless $opt{heading};
    my (undef, $lines) = read_file($file);
    my $start = -1;
    for my $i (0 .. $#$lines) {
        if ($lines->[$i] =~ /^#{1,6}\s+.*\Q$opt{heading}\E/i) {
            $start = $i;
            last;
        }
    }
    die "heading not found: $opt{heading}\n" if $start < 0;
    my $end = $start + $opt{lines} - 1;
    $end = $#$lines if $end > $#$lines;
    print join('', @$lines[$start .. $end]);
    exit 0;
}

if ($command eq 'digest') {
    my %opt = (target_words => 450);
    GetOptionsFromArray(\@ARGV, \%opt, 'target-words=i') or usage();
    my $file = shift @ARGV // usage();
    my ($text, $lines) = read_file($file);
    my @headings = headings($lines, 120);
    my @paras = grep { length($_) > 40 } split /\n\s*\n/, $text;
    my @parts;
    push @parts, map { $_->{text} } @headings[0 .. (@headings < 8 ? $#headings : 7)] if @headings;
    for my $para (@paras) {
        last if word_count(join("\n", @parts)) >= $opt{target_words};
        push @parts, compact(first_sentence($para));
    }
    print_json({
        ok => JSON::PP::true,
        file => $file,
        sourceWords => word_count($text),
        digestWords => word_count(join(' ', @parts)),
        digest => join("\n", grep { length($_) } @parts),
    });
    exit 0;
}

usage();

sub read_file {
    my ($file) = @_;
    open my $fh, '<:encoding(UTF-8)', $file or die "cannot read $file: $!\n";
    my @lines = <$fh>;
    my $text = join('', @lines);
    return ($text, \@lines);
}

sub headings {
    my ($lines, $max_excerpt) = @_;
    my @items;
    for my $i (0 .. $#$lines) {
        next unless $lines->[$i] =~ /^(#{1,6})\s+(.+?)\s*$/;
        my ($level, $title) = (length($1), trim($2));
        my $j = $i + 1;
        my $excerpt = '';
        while ($j <= $#$lines && $lines->[$j] !~ /^#{1,6}\s+/) {
            $excerpt .= $lines->[$j];
            last if length($excerpt) >= $max_excerpt * 2;
            $j++;
        }
        push @items, {
            level => $level,
            line => $i + 1,
            title => $title,
            excerpt => compact(substr($excerpt, 0, $max_excerpt)),
        };
    }
    return @items;
}

sub word_count {
    my ($text) = @_;
    my @words = $text =~ /\S+/g;
    return scalar @words;
}

sub first_sentence {
    my ($text) = @_;
    $text = compact($text);
    return $1 if $text =~ /^(.{40,360}?[.!?])(?:\s|$)/;
    return substr($text, 0, 360);
}

sub compact {
    my ($text) = @_;
    $text //= '';
    $text =~ s/\s+/ /g;
    return trim($text);
}

sub trim {
    my ($text) = @_;
    $text //= '';
    $text =~ s/^\s+//;
    $text =~ s/\s+$//;
    return $text;
}

sub print_json {
    my ($value) = @_;
    print encode_json($value), "\n";
}

sub usage {
    die <<"USAGE";
Usage:
  proser_manuscript_scout.pl map FILE [--max-excerpt N]
  proser_manuscript_scout.pl search FILE PATTERN [--context N] [--limit N] [--regex] [--ignore-case]
  proser_manuscript_scout.pl slice FILE --heading TEXT [--lines N]
  proser_manuscript_scout.pl digest FILE [--target-words N]
USAGE
}
