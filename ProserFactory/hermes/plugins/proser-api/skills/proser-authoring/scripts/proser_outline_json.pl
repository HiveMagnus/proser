#!/usr/bin/env perl
use strict;
use warnings;
use utf8;
use JSON::PP qw(encode_json);

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my $file = shift @ARGV or die "Usage: proser_outline_json.pl OUTLINE.md\n";
open my $fh, '<:encoding(UTF-8)', $file or die "cannot read $file: $!\n";

my @acts;
my ($act, $chapter, $scene);
while (my $line = <$fh>) {
    chomp $line;
    next if $line =~ /^\s*$/;
    if ($line =~ /^#\s+(.+)/ || $line =~ /^-\s*Act\s+\d+\s*:?\s*(.+)/i) {
        $act = { title => clean_title($1), summary => undef, chapters => [] };
        push @acts, $act;
        $chapter = undef;
        $scene = undef;
        next;
    }
    if ($line =~ /^##\s+(.+)/ || $line =~ /^\s*-\s*Chapter\s+\d+\s*:?\s*(.+)/i) {
        ensure_act();
        $chapter = { title => clean_title($1), summary => undef, scenes => [] };
        push @{ $act->{chapters} }, $chapter;
        $scene = undef;
        next;
    }
    if ($line =~ /^###\s+(.+)/ || $line =~ /^\s*-\s*Scene\s+\d+(?:\.\d+)?\s*:?\s*(.+)/i) {
        ensure_chapter();
        $scene = { title => clean_title($1), summary => undef, outline => undef };
        push @{ $chapter->{scenes} }, $scene;
        next;
    }
    if ($line =~ /^\s*(?:summary|synopsis)\s*:\s*(.+)$/i) {
        my $summary = clean_text($1);
        if ($scene) {
            $scene->{summary} = append_text($scene->{summary}, $summary);
        } elsif ($chapter) {
            $chapter->{summary} = append_text($chapter->{summary}, $summary);
        } elsif ($act) {
            $act->{summary} = append_text($act->{summary}, $summary);
        }
        next;
    }
    my $text = clean_text($line);
    if ($scene) {
        $scene->{outline} = append_text($scene->{outline}, $text);
    } elsif ($chapter) {
        $chapter->{summary} = append_text($chapter->{summary}, $text);
    } elsif ($act) {
        $act->{summary} = append_text($act->{summary}, $text);
    }
}

for my $a (@acts) {
    delete $a->{summary} unless defined $a->{summary} && length $a->{summary};
    for my $c (@{ $a->{chapters} }) {
        delete $c->{summary} unless defined $c->{summary} && length $c->{summary};
        for my $s (@{ $c->{scenes} }) {
            delete $s->{summary} unless defined $s->{summary} && length $s->{summary};
            delete $s->{outline} unless defined $s->{outline} && length $s->{outline};
        }
    }
}

my @structure_acts = map {
    {
        title => $_->{title},
        (defined $_->{summary} ? (summary => $_->{summary}) : ()),
        chapters => [
            map {
                {
                    title => $_->{title},
                    (defined $_->{summary} ? (summary => $_->{summary}) : ()),
                }
            } @{ $_->{chapters} }
        ],
    }
} @acts;

print encode_json({
    ok => JSON::PP::true,
    saveStructureBody => { acts => \@structure_acts },
    scenePlan => \@acts,
}), "\n";

sub ensure_act {
    return if $act;
    $act = { title => 'Act 1', summary => undef, chapters => [] };
    push @acts, $act;
}

sub ensure_chapter {
    ensure_act();
    return if $chapter;
    $chapter = { title => 'Chapter 1', summary => undef, scenes => [] };
    push @{ $act->{chapters} }, $chapter;
}

sub clean_title {
    my ($text) = @_;
    $text = clean_text($text);
    $text =~ s/^(?:Act|Chapter|Scene)\s+\d+(?:\.\d+)?\s*:?\s*//i;
    return $text || 'Untitled';
}

sub clean_text {
    my ($text) = @_;
    $text //= '';
    $text =~ s/^\s*[-*]\s*//;
    $text =~ s/\s+/ /g;
    $text =~ s/^\s+|\s+$//g;
    return $text;
}

sub append_text {
    my ($old, $new) = @_;
    return $old unless defined $new && length $new;
    return $new unless defined $old && length $old;
    return "$old $new";
}
